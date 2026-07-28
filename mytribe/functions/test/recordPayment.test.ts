import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { recordPaymentHandler } from '../src/admin/recordPayment';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(
  data: unknown,
  uid: string | null = 'admin1',
  token: Record<string, unknown> = { admin: true },
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed() {
  return buildDbMock();
}

function paymentWriteOf(ctx: ReturnType<typeof seed>) {
  return ctx.writes.find((w) => w.path.startsWith('payments/'));
}

const fullArgs = {
  kinfolkId: 'fam1',
  kinfolkName: 'The Riveras',
  client: 'Ana Rivera',
  address: '12 Elm St',
  date: '2026-07-28',
  paymentMethod: 'venmo',
  referenceNumber: 'VN-42',
  email: 'ana@example.com',
  amount: 40,
  tip: 5,
  notes: 'July visits',
  invoiceId: 'inv1',
  invoiceNumber: 'INV-9',
};

describe('recordPayment happy path', () => {
  it('creates the root payments row with every field plus recordedBy/createdAt', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(fullArgs));
    expect(res.ok).toBe(true);
    expect(res.paymentId).toBeTruthy();
    expect(res.kinfolkId).toBe('fam1');
    const w = paymentWriteOf(ctx);
    expect(w?.data).toMatchObject({ ...fullArgs, recordedBy: 'admin1', createdAt: '__TS__' });
    // No `id` field inside the doc: android's @DocumentId never serialized one.
    expect(w?.data).not.toHaveProperty('id');
  });

  it('defaults every omitted legacy field, so a minimal standalone payment validates', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req({ amount: 25 }));
    expect(res.ok).toBe(true);
    const w = paymentWriteOf(ctx);
    expect(w?.data).toMatchObject({
      kinfolkId: '', kinfolkName: '', client: '', address: '', date: '',
      paymentMethod: '', referenceNumber: '', email: '', amount: 25, tip: 0,
      notes: '', invoiceId: '', invoiceNumber: '',
    });
  });

  it('writes the BILLING_PAYMENT_RECORDED audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await recordPaymentHandler(req(fullArgs));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_PAYMENT_RECORDED',
        targetCollection: 'payments',
        familyId: 'fam1',
        payload: expect.objectContaining({
          invoiceId: 'inv1',
          amount: 40,
          tip: 5,
          method: 'venmo',
          reference: 'VN-42',
          testMode: false,
        }),
      }),
    );
  });
});

describe('recordPayment TestMode scoping (server-side, replacing the client-side copy)', () => {
  const testToken = { testTribeId: 'test-kinfolk-001' };

  it("stamps the sandbox kinfolkId no matter what the caller sent", async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(
      req({ ...fullArgs, kinfolkId: 'fam1' }, 'testuser1', testToken),
    );
    expect(res.kinfolkId).toBe('test-kinfolk-001');
    expect(paymentWriteOf(ctx)?.data.kinfolkId).toBe('test-kinfolk-001');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'test-kinfolk-001',
        payload: expect.objectContaining({ testMode: true }),
      }),
    );
  });

  it('staff keep the kinfolkId they sent', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(req(fullArgs));
    expect(res.kinfolkId).toBe('fam1');
  });

  it('staff carrying a stray test claim stay UNSCOPED (rules precedence: isAuntie() wins)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await recordPaymentHandler(
      req(fullArgs, 'admin1', { admin: true, testTribeId: 'test-kinfolk-001' }),
    );
    expect(res.kinfolkId).toBe('fam1');
  });
});

describe('recordPayment gate + validation', () => {
  it('refuses an unauthenticated call', async () => {
    await expect(recordPaymentHandler(req({ amount: 1 }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses a caller with neither the admin claim nor a test claim', async () => {
    await expect(recordPaymentHandler(req({ amount: 1 }, 'someone', {}))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('a blank testTribeId claim does NOT half-enable the sandbox path', async () => {
    await expect(
      recordPaymentHandler(req({ amount: 1 }, 'someone', { testTribeId: '   ' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses a malformed request', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const bad of [
      {},
      { amount: -1 },
      { amount: 'forty' },
      { amount: 40, tip: -1 },
      { amount: 40, kinfolkId: 'x'.repeat(121) },
    ]) {
      await expect(recordPaymentHandler(req(bad))).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
    expect(ctx.writes).toEqual([]);
  });
});
