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

import { runAutoApplyHandler } from '../src/admin/runAutoApply';

beforeEach(() => mocks.dbFn.mockReset());

/**
 * The on-demand half of auto-apply.
 *
 * The trigger only fires on the transition into collectable, so the two most
 * ordinary cases in the world are unreachable without this: she ticks the box
 * on a payment for a household whose invoice is already sent, and a trigger
 * that failed left credit unspent against a bill that still says it is owed.
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

describe('runAutoApply: the happy path', () => {
  it('spends the household credit on the named invoice and reports every figure', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await runAutoApplyHandler(req({ invoiceId: 'inv1' }));

    expect(res.ok).toBe(true);
    expect(res.skipped).toBe('');
    expect(res.appliedCents).toBe(10000);
    expect(res.amountDueCents).toBe(0);
    // $120 held, $100 spent, $20 still on account for the invoice after this.
    expect(res.accountBalanceCents).toBe(2000);
  });

  it('is safe to press twice: the second pass finds a drained balance', async () => {
    const ctx = seed({ family: { accountBalanceCents: 0 } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await runAutoApplyHandler(req({ invoiceId: 'inv1' }));
    expect(res.skipped).toBe('no_credit');
    expect(res.appliedCents).toBe(0);
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('runAutoApply: skipped is an ANSWER, not an error channel', () => {
  async function skipped(over: Parameters<typeof seed>[0]) {
    const ctx = seed(over);
    mocks.dbFn.mockReturnValue(ctx.db);
    return (await runAutoApplyHandler(req({ invoiceId: 'inv1' }))).skipped;
  }

  it('says a draft is not collectable rather than throwing at the operator', async () => {
    // Throwing would make "nothing needed doing" look like "something broke",
    // which is how an operator learns to ignore the red.
    expect(await skipped({ invoice: { kinfolkId: 'fam1', status: 'draft', total: 100 } })).toBe(
      'invoice_not_collectable',
    );
  });

  it('says a settled invoice is not collectable', async () => {
    expect(await skipped({ subPayments: [{ id: 'p1', data: { amountCents: 10000 } }] })).toBe(
      'invoice_not_collectable',
    );
  });

  it('says an invoice with no household cannot be credited', async () => {
    expect(await skipped({ invoice: { status: 'open', total: 100 } })).toBe('no_household');
  });

  it('says there is no credit when the family holds none', async () => {
    expect(await skipped({ family: { accountBalanceCents: 0 } })).toBe('no_credit');
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

  it('ADMITS a sandbox admin inside their own tribe, like every callable on this surface', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { kinfolkId: 'test-kinfolk-001', status: 'open', total: 100 },
        'families/test-kinfolk-001': { accountBalanceCents: 5000 },
      },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await runAutoApplyHandler(
      req({ invoiceId: 'inv1' }, { testTribeId: 'test-kinfolk-001' }, 'tester'),
    );
    expect(res.appliedCents).toBe(5000);
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
