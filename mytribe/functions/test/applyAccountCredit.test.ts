import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), enqueue: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({
  resolveBillingRecipientUid: async () => 'kin-uid-1',
}));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotificationDetailed: async (args: unknown) => {
    mocks.enqueue(args);
    return { written: ['n1'], suppressed: [], unresolved: [] };
  },
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
      delete: () => ({ __delete: true }),
    },
  };
});
import {
  APPLY_CREDIT_IDEMPOTENCY_KEY_RE,
  applyAccountCreditHandler,
  applyCreditRefusalMessage,
  Result,
} from '../src/admin/applyAccountCredit';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset();
});

/**
 * #1872: THE ONE PATH THAT SPENDS ACCOUNT CREDIT. The admin enters an amount
 * against one open invoice; the server checks it and writes it in one
 * transaction. Nothing else in the tree moves credit onto an invoice.
 */
const KEY = 'acr_1790000000000_abc123';

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

interface Seed {
  invoice?: Record<string, unknown> | null;
  family?: Record<string, unknown> | null;
  subPayments?: Array<{ id: string; data: Record<string, unknown> }>;
  extra?: Record<string, Record<string, unknown> | null>;
}

function seed(s: Seed = {}) {
  const ctx = buildDbMock({
    docs: {
      'invoices/inv1':
        s.invoice === undefined
          ? { kinfolkId: 'fam1', status: 'open', total: 100, invoiceNumber: '1026' }
          : s.invoice,
      'families/fam1': s.family === undefined ? { accountBalanceCents: 12000 } : s.family,
      ...(s.extra ?? {}),
    },
    queryDocs: { 'invoices/inv1/payments': s.subPayments ?? [] },
    writeThrough: true,
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}
const ok = { invoiceId: 'inv1', amountCents: 2500, idempotencyKey: KEY };

describe('applyAccountCredit: the admin applies an amount she entered', () => {
  it('moves exactly that amount and reports every figure', async () => {
    const ctx = seed();
    const res = await applyAccountCreditHandler(req(ok));
    expect(Result.safeParse(res).success).toBe(true);
    expect(res).toEqual({
      ok: true,
      invoiceId: 'inv1',
      paymentId: KEY,
      appliedCents: 2500,
      amountDueCents: 7500,
      accountBalanceCents: 9500,
      replayed: false,
    });
    expect(ctx.writes.find((w) => w.path === `invoices/inv1/payments/${KEY}`)?.data).toMatchObject({
      amountCents: 2500,
      method: 'account credit',
      fromAccountCredit: true,
      recordedBy: 'admin1',
    });
    expect(ctx.writes.find((w) => w.path === 'families/fam1')?.data.accountBalanceCents).toBe(9500);
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')?.data).toMatchObject({
      status: 'open',
      paymentStatus: 'PARTIAL',
      amountDueCents: 7500,
    });
  });

  it('writes the payment, the balance, the credit history and the Activity Log line in ONE transaction', async () => {
    const ctx = seed();
    await applyAccountCreditHandler(req(ok));
    expect((ctx.db as any).runTransaction).toHaveBeenCalledTimes(1);
    const paths = ctx.writes.map((w) => w.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `invoices/inv1/payments/${KEY}`,
        'families/fam1',
        `families/fam1/creditLedger/draw_${KEY}`,
        `activity_log/account_credit_applied_${KEY}`,
        'activity_log_chain_head/current',
        'invoices/inv1',
      ]),
    );
    expect(ctx.writes.find((w) => w.path.startsWith('activity_log/'))?.data).toMatchObject({
      actionType: 'BILLING_ACCOUNT_CREDIT_APPLIED',
      description: 'Applied $25.00 account credit to invoice 1026',
      actorId: 'admin1',
      familyId: 'fam1',
    });
  });

  it('pays the invoice off when she enters the whole balance, and tells the household it is paid', async () => {
    const ctx = seed();
    const res = await applyAccountCreditHandler(req({ ...ok, amountCents: 10000 }));
    expect(res.amountDueCents).toBe(0);
    expect(res.accountBalanceCents).toBe(2000);
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')?.data.status).toBe('paid');
    const keys = mocks.enqueue.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys).toContain('invoice.payment.applied');
  });

  it('a part payment from credit tells nobody', async () => {
    seed();
    await applyAccountCreditHandler(req(ok));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('admits a sandbox admin inside their own tribe', async () => {
    seed({
      invoice: { kinfolkId: 'test-kinfolk-001', status: 'open', total: 100 },
      extra: { 'families/test-kinfolk-001': { accountBalanceCents: 5000 } },
    });
    const res = await applyAccountCreditHandler(req(ok, { testTribeId: 'test-kinfolk-001' }, 'tester'));
    expect(res.appliedCents).toBe(2500);
  });
});

describe('applyAccountCredit: a double tap applies once', () => {
  it('the second call with the same key returns the first answer and writes nothing', async () => {
    const ctx = seed();
    const first = await applyAccountCreditHandler(req(ok));
    const writes = ctx.writes.length;
    const second = await applyAccountCreditHandler(req(ok));
    expect(second).toEqual({ ...first, replayed: true });
    expect(ctx.writes).toHaveLength(writes);
    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/inv1/payments/'))).toHaveLength(1);
    expect(ctx.writes.filter((w) => w.path.startsWith('activity_log/'))).toHaveLength(1);
  });

  it('a double tap on a pay-off answers with the success, not "already paid"', async () => {
    seed();
    const first = await applyAccountCreditHandler(req({ ...ok, amountCents: 10000 }));
    const second = await applyAccountCreditHandler(req({ ...ok, amountCents: 10000 }));
    expect(second).toEqual({ ...first, replayed: true });
  });

  it('refuses a key another admin already used', async () => {
    seed({
      extra: {
        [`invoices/inv1/payments/${KEY}`]: { amountCents: 2500, recordedBy: 'admin2', fromAccountCredit: true },
      },
    });
    await expect(applyAccountCreditHandler(req(ok))).rejects.toMatchObject({ code: 'already-exists' });
  });

  it('requires the key, in its own shape', async () => {
    seed();
    expect(APPLY_CREDIT_IDEMPOTENCY_KEY_RE.test(KEY)).toBe(true);
    for (const idempotencyKey of [undefined, '', 'crd_1790000000000_abc123', 'acr_x']) {
      await expect(
        applyAccountCreditHandler(req({ ...ok, idempotencyKey })),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }
  });
});

describe('applyAccountCredit: what it refuses, in words for the field', () => {
  async function refused(s: Seed, over: Record<string, unknown> = {}) {
    const ctx = seed(s);
    const err = await applyAccountCreditHandler(req({ ...ok, ...over })).then(
      () => null,
      (e) => e as { code: string; message: string; details?: Record<string, unknown> },
    );
    expect(err, 'expected a refusal').not.toBeNull();
    expect(ctx.writes).toHaveLength(0);
    return err!;
  }

  it('more than the household has', async () => {
    const err = await refused({ family: { accountBalanceCents: 1200 } });
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe('This household has $12.00 of account credit. Enter that much or less.');
    expect(err.details).toMatchObject({ reason: 'over_credit', accountBalanceCents: 1200 });
  });

  it('a household with no credit', async () => {
    const err = await refused({ family: { accountBalanceCents: 0 } });
    expect(err.message).toBe('This household has no account credit.');
    expect(err.details).toMatchObject({ reason: 'over_credit' });
  });

  it('more than the invoice has left to pay', async () => {
    const err = await refused({ subPayments: [{ id: 'p1', data: { amountCents: 9000 } }] });
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe('This invoice has $10.00 left to pay. Enter that much or less.');
    expect(err.details).toMatchObject({ reason: 'over_balance', amountDueCents: 1000 });
  });

  it('zero', async () => {
    const err = await refused({}, { amountCents: 0 });
    expect(err.code).toBe('invalid-argument');
    expect(err.message).toBe('Enter an amount above $0.00.');
    expect(err.details).toMatchObject({ reason: 'amount_invalid' });
  });

  it('a negative amount', async () => {
    const err = await refused({}, { amountCents: -500 });
    expect(err.code).toBe('invalid-argument');
    expect(err.details).toMatchObject({ reason: 'amount_invalid' });
  });

  it('a fraction of a cent, text, and a missing amount', async () => {
    for (const amountCents of [10.5, '2500', undefined, null]) {
      const err = await refused({}, { amountCents });
      expect(err.code, String(amountCents)).toBe('invalid-argument');
    }
  });

  it('a paid invoice', async () => {
    const err = await refused({ subPayments: [{ id: 'p1', data: { amountCents: 10000 } }] });
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe('This invoice is already paid, so it takes no credit.');
    expect(err.details).toMatchObject({ reason: 'invoice_paid' });
  });

  it('an invoice marked paid with no payment rows', async () => {
    const err = await refused({ invoice: { kinfolkId: 'fam1', status: 'paid', total: 100 } });
    expect(err.details).toMatchObject({ reason: 'invoice_paid' });
  });

  it('a draft', async () => {
    const err = await refused({ invoice: { kinfolkId: 'fam1', status: 'draft', total: 100 } });
    expect(err.message).toBe('This invoice is a draft. Send it before you apply credit.');
    expect(err.details).toMatchObject({ reason: 'invoice_draft' });
  });

  it('a quote', async () => {
    const err = await refused({ invoice: { kinfolkId: 'fam1', status: 'quote', total: 100 } });
    expect(err.details).toMatchObject({ reason: 'invoice_quote' });
  });

  it('an archived invoice', async () => {
    const err = await refused({
      invoice: { kinfolkId: 'fam1', status: 'open', total: 100, archivedAt: '__TS__' },
    });
    expect(err.message).toBe('This invoice is archived, so it takes no credit.');
    expect(err.details).toMatchObject({ reason: 'invoice_archived' });
  });

  it('a cancelled invoice', async () => {
    const err = await refused({ invoice: { kinfolkId: 'fam1', status: 'cancelled', total: 100 } });
    expect(err.details).toMatchObject({ reason: 'invoice_not_collectable' });
  });

  it('an invoice that does not exist', async () => {
    const err = await refused({ invoice: null });
    expect(err.code).toBe('not-found');
  });

  it('an unknown field, rather than ignoring it', async () => {
    const err = await refused({}, { kinfolkId: 'fam2' });
    expect(err.code).toBe('invalid-argument');
  });

  it('every refusal has words with no code, id or dash in them', () => {
    const reasons = [
      'invoice_missing', 'no_household', 'invoice_draft', 'invoice_quote', 'invoice_archived',
      'invoice_paid', 'invoice_not_collectable', 'amount_invalid', 'over_credit', 'over_balance',
    ] as const;
    for (const reason of reasons) {
      const words = applyCreditRefusalMessage(reason, { accountBalanceCents: 1200, amountDueCents: 1000 });
      expect(words, reason).toMatch(/^[A-Z].*\.$/);
      expect(words, reason).not.toMatch(/[_—]|inv1|fam1/);
    }
  });
});

describe('applyAccountCredit: who may not', () => {
  it('refuses an Auntie: a caretaker never sees money', async () => {
    const ctx = seed();
    await expect(
      applyAccountCreditHandler(req(ok, { staffRole: 'auntie' }, 'auntie1')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses an Auntie even when her token also carries the admin claim', async () => {
    const ctx = seed();
    await expect(
      applyAccountCreditHandler(req(ok, { staffRole: 'auntie', admin: true }, 'auntie1')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a Kinfolk', async () => {
    const ctx = seed();
    await expect(applyAccountCreditHandler(req(ok, {}, 'kin1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a caller who is not signed in', async () => {
    seed();
    await expect(applyAccountCreditHandler(req(ok, {}, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses a sandbox admin reaching outside their own tribe', async () => {
    const ctx = seed();
    await expect(
      applyAccountCreditHandler(req(ok, { testTribeId: 'test-kinfolk-001' }, 'tester')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });
});
