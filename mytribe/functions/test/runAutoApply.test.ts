import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
    },
  };
});

import { AUTO_APPLY_DISABLED_REASON, runAutoApplyHandler } from '../src/admin/runAutoApply';

beforeEach(() => mocks.dbFn.mockReset());

/**
 * #1872, operator ruling 2026-11-11: this callable took no amount and spent
 * everything the household held. It is disabled: every call from someone
 * allowed to make it is refused and writes nothing. Credit is applied through
 * `applyAccountCredit`, by an amount the admin enters.
 */
function req(
  data: unknown,
  token: Record<string, unknown> = { admin: true },
  uid: string | null = 'admin1',
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(
  s: {
    invoice?: Record<string, unknown> | null;
    family?: Record<string, unknown> | null;
    subPayments?: Array<{ id: string; data: Record<string, unknown> }>;
  } = {},
) {
  return buildDbMock({
    docs: {
      'invoices/inv1':
        s.invoice === undefined ? { kinfolkId: 'fam1', status: 'open', total: 100 } : s.invoice,
      'families/fam1': s.family === undefined ? { accountBalanceCents: 12000 } : s.family,
    },
    queryDocs: { 'invoices/inv1/payments': s.subPayments ?? [] },
  });
}

describe('runAutoApply: disabled, it spends nothing (#1872)', () => {
  it('refuses an admin and leaves the credit and the invoice untouched', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(runAutoApplyHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Account credit is applied only as an amount you enter on the invoice.',
      details: { reason: AUTO_APPLY_DISABLED_REASON },
    });
    expect(ctx.writes).toHaveLength(0);
  });
  it('refuses a sandbox admin inside their own tribe the same way', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { kinfolkId: 'test-kinfolk-001', status: 'open', total: 100 },
        'families/test-kinfolk-001': { accountBalanceCents: 5000 },
      },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      runAutoApplyHandler(req({ invoiceId: 'inv1' }, { testTribeId: 'test-kinfolk-001' }, 'tester')),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });
});
describe('runAutoApply: refusals', () => {
  it('throws not-found for an invoice that does not exist', async () => {
    const ctx = seed({ invoice: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(runAutoApplyHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a sandbox admin reaching outside their own tribe', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      runAutoApplyHandler(req({ invoiceId: 'inv1' }, { testTribeId: 'test-kinfolk-001' }, 'tester')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      runAutoApplyHandler(req({ invoiceId: 'inv1' }, {}, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('refuses a signed-in caller who is neither staff nor a scoped test admin', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      runAutoApplyHandler(req({ invoiceId: 'inv1' }, {}, 'randomuser')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses a missing invoiceId at validation, naming the field', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(runAutoApplyHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses an unknown key rather than silently ignoring it', async () => {
    // `.strict()`: a caller sending `invoice` instead of `invoiceId` finds out.
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(
      runAutoApplyHandler(req({ invoiceId: 'inv1', amount: 50 })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
