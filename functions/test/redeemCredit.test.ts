import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  stripeMock: {
    refunds: { create: vi.fn() },
  },
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/stripe', () => ({ getStripe: () => mocks.stripeMock }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__SERVER_TS__',
      increment: (n: number) => ({ __increment: n }),
    },
  };
});
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.stripeMock.refunds.create.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
  },
};
const BILLING_FULL_SECONDARY = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: true,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: false,
  },
};
const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };
const redeemData = { invoiceId: 'inv-c1', target: 'accountBalance' as const };

describe('redeemCredit PRIMARY-only billing gate', () => {
  it('DENIES a kintales_only secondary and never touches the family balance', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c1': { kinfolkId: '3', amountDue: -25.5, invoiceStatus: 'credit' },
        'families/3': { accountBalanceCents: 0 },
        'families/3/members/u1': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(redeemCreditHandler({ data: redeemData, auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // no balance bump, no invoice stamp
    expect(ctx.writes.find((w) => w.path === 'families/3')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'invoices/inv-c1')).toBeUndefined();
  });

  it('DENIES a secondary with billing_full=true (PK-only policy: billing_full is no longer honored)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c1': { kinfolkId: '3', amountDue: -25.5, invoiceStatus: 'credit' },
        'families/3': { accountBalanceCents: 0 },
        'families/3/members/u1': BILLING_FULL_SECONDARY,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(redeemCreditHandler({ data: redeemData, auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // no balance bump, no invoice stamp
    expect(ctx.writes.find((w) => w.path === 'families/3')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'invoices/inv-c1')).toBeUndefined();
  });

  it('ALLOWS a PRIMARY member', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c1': { kinfolkId: '3', amountDue: -25.5, invoiceStatus: 'credit' },
        'families/3': { accountBalanceCents: 0 },
        'families/3/members/u1': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    const res = await redeemCreditHandler({ data: redeemData, auth: { uid: 'u1' } } as any);
    expect(res.ok).toBe(true);
    expect(res.redeemedAmountCents).toBe(2550);
  });

  it('ALLOWS legacy (no member doc)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c1': { kinfolkId: '3', amountDue: -25.5, invoiceStatus: 'credit' },
        'families/3': { accountBalanceCents: 0 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    const res = await redeemCreditHandler({ data: redeemData, auth: { uid: 'u1' } } as any);
    expect(res.ok).toBe(true);
  });

  it('ALLOWS an operator (bypass, no member doc)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: ['3'] },
        'invoices/inv-c1': { kinfolkId: '3', amountDue: -25.5, invoiceStatus: 'credit' },
        'families/3': { accountBalanceCents: 0 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    const res = await redeemCreditHandler({ data: redeemData, auth: { uid: 'op-uid' } } as any);
    expect(res.ok).toBe(true);
  });
});

describe('redeemCreditHandler', () => {
  it('rejects unauth', async () => {
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({ data: { invoiceId: 'x', target: 'accountBalance' }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects when invoice missing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({
        data: { invoiceId: 'missing', target: 'accountBalance' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects when invoice belongs to a different tribe', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-other': { kinfolkId: '99', amountDue: -50 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({
        data: { invoiceId: 'inv-other', target: 'accountBalance' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects non-credit invoices', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 50, total: 100 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({
        data: { invoiceId: 'inv-1', target: 'accountBalance' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects already-redeemed credits (idempotency) — guard is INSIDE the tx, no side effects', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c1': {
          kinfolkId: '3',
          amountDue: -50,
          invoiceStatus: 'credit',
          creditRedeemedAt: Timestamp.fromMillis(123),
        },
        'families/3': { accountBalanceCents: 1000 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({
        data: { invoiceId: 'inv-c1', target: 'accountBalance' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: 'Credit already redeemed.' });
    // The atomic guard fires inside the tx BEFORE any write: balance untouched,
    // invoice not re-stamped, Stripe never called.
    expect(ctx.writes.find((w) => w.path === 'families/3')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'invoices/inv-c1')).toBeUndefined();
    expect(mocks.stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it('accountBalance applies absolute new balance (old+amount) atomically and stamps invoice', async () => {
    // Family already holds 1000c; redeeming a 2550c credit must write the
    // computed absolute total (3550c), not a FieldValue.increment. The apply is
    // INSIDE the claim transaction, so it is atomic with the stamp.
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c1': { kinfolkId: '3', amountDue: -25.5, invoiceStatus: 'credit' },
        'families/3': { accountBalanceCents: 1000 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    const res = await redeemCreditHandler({
      data: { invoiceId: 'inv-c1', target: 'accountBalance' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.ok).toBe(true);
    expect(res.target).toBe('accountBalance');
    expect(res.redeemedAmountCents).toBe(2550);
    expect(res.refundId).toBeNull();
    expect(res.newAccountBalanceCents).toBe(3550); // 1000 + 2550

    const familyWrite = ctx.writes.find((w) => w.path === 'families/3');
    expect(familyWrite).toBeDefined();
    expect(familyWrite!.merge).toBe(true);
    // Absolute computed balance, NOT FieldValue.increment.
    expect(familyWrite!.data.accountBalanceCents).toBe(3550);
    expect((familyWrite!.data.accountBalanceCents as any)?.__increment).toBeUndefined();

    const invoiceWrite = ctx.writes.find((w) => w.path === 'invoices/inv-c1');
    expect(invoiceWrite!.data.creditTarget).toBe('accountBalance');
    expect(invoiceWrite!.data.creditAmountCents).toBe(2550);
    expect(invoiceWrite!.data.creditRedeemedAt).toBe('__SERVER_TS__');
    expect(invoiceWrite!.data.creditRedeemedByUid).toBe('u1');
  });

  it('originalPaymentMethod requires originalPaymentIntentId', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c2': { kinfolkId: '3', amountDue: -10 /* no original PI */ },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({
        data: { invoiceId: 'inv-c2', target: 'originalPaymentMethod' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('originalPaymentMethod calls Stripe refund and stamps invoice', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c3': {
          kinfolkId: '3',
          amountDue: -100,
          originalPaymentIntentId: 'pi_test_123',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.refunds.create.mockResolvedValueOnce({ id: 're_test_456' });
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    const res = await redeemCreditHandler({
      data: { invoiceId: 'inv-c3', target: 'originalPaymentMethod' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.refundId).toBe('re_test_456');
    expect(res.target).toBe('originalPaymentMethod');
    expect(res.newAccountBalanceCents).toBeNull();
    // Stripe refund carries the idempotency key so a retry cannot double-refund.
    expect(mocks.stripeMock.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_test_123', amount: 10_000 },
      { idempotencyKey: 'credit-inv-c3' },
    );
    // Invoice stamped in the claim tx (creditRefundId null), then filled after Stripe.
    const stampWrite = ctx.writes.find(
      (w) => w.path === 'invoices/inv-c3' && w.data.creditRedeemedAt === '__SERVER_TS__',
    );
    expect(stampWrite).toBeDefined();
    expect(stampWrite!.data.creditRedeemedByUid).toBe('u1');
    const refundWrite = ctx.writes.find(
      (w) => w.path === 'invoices/inv-c3' && w.data.creditRefundId === 're_test_456',
    );
    expect(refundWrite).toBeDefined();
  });

  it('rejects zero-amount credits', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-zero': { kinfolkId: '3', invoiceStatus: 'credit', amountDue: 0, total: 0 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({
        data: { invoiceId: 'inv-zero', target: 'accountBalance' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('Stripe refund failure RELEASES the claim (creditRedeemedAt stamped then cleared) so a retry is possible', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-c4': {
          kinfolkId: '3',
          amountDue: -100,
          originalPaymentIntentId: 'pi_fail_999',
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.refunds.create.mockRejectedValueOnce(new Error('card_declined'));
    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    await expect(
      redeemCreditHandler({
        data: { invoiceId: 'inv-c4', target: 'originalPaymentMethod' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'unavailable', message: 'Refund failed: card_declined' });

    // Idempotency key still present on the attempted refund.
    expect(mocks.stripeMock.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_fail_999', amount: 10_000 },
      { idempotencyKey: 'credit-inv-c4' },
    );

    const invoiceWrites = ctx.writes.filter((w) => w.path === 'invoices/inv-c4');
    // First the claim stamp (creditRedeemedAt set)...
    const stampWrite = invoiceWrites.find((w) => w.data.creditRedeemedAt === '__SERVER_TS__');
    expect(stampWrite).toBeDefined();
    // ...then a release write resetting creditRedeemedAt back to null.
    const releaseWrite = invoiceWrites.find(
      (w) => 'creditRedeemedAt' in w.data && w.data.creditRedeemedAt === null,
    );
    expect(releaseWrite).toBeDefined();
    expect(releaseWrite!.data.creditTarget).toBeNull();
    expect(releaseWrite!.data.creditAmountCents).toBeNull();
    // Order: stamp recorded before release.
    expect(invoiceWrites.indexOf(stampWrite!)).toBeLessThan(invoiceWrites.indexOf(releaseWrite!));
  });
});

describe('redeemCredit CRITICAL-3 claim-first atomicity (race)', () => {
  // Custom db whose runTransaction serializes the callback against a shared,
  // mutating in-memory store (mirrors saveFormSchema's concurrency test). The
  // default buildDbMock txn shim reads from a STATIC docs map and never commits
  // stamps back, so it can't model a real claim race; this one can: once the
  // first redeem stamps `creditRedeemedAt`, the second transaction re-reads the
  // committed stamp and the in-tx guard rejects it.
  it('two concurrent redeems: exactly one applies (single increment, one already-redeemed)', async () => {
    const invoiceState: Record<string, unknown> = {
      kinfolkId: '3',
      amountDue: -25.5, // 2550c
      invoiceStatus: 'credit',
    };
    const store: Record<string, Record<string, unknown> | null> = {
      'invoices/inv-race': invoiceState,
      'families/3': { accountBalanceCents: 1000 },
    };

    const familyWrites: Array<Record<string, unknown>> = [];

    function makeRef(path: string): any {
      return {
        id: path.split('/').pop(),
        path,
        // Non-tx (outer auth read + post-tx writes) hit the live store too.
        get: async () => ({
          exists: store[path] != null,
          data: () => store[path] ?? undefined,
        }),
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          store[path] = opts?.merge ? { ...(store[path] ?? {}), ...data } : data;
        },
      };
    }

    let txnTail: Promise<unknown> = Promise.resolve();
    const customDb: any = {
      collection: (col: string) => ({
        doc: (id: string) => {
          if (col === 'clients') {
            return { get: async () => ({ exists: true, data: () => ({ kinfolkIds: ['3'] }) }) };
          }
          return makeRef(`${col}/${id}`);
        },
      }),
      // requireKinfolkPerm reads `families/{id}/members/{uid}` via db().doc(path).
      // No member doc -> legacy null branch (allowed by the outer kinfolkIds gate).
      doc: (path: string) => makeRef(path),
      runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        // Serialize: each tx waits for the previous to fully commit.
        const prev = txnTail;
        let release: () => void = () => {};
        txnTail = new Promise<void>((r) => {
          release = r;
        });
        await prev;
        try {
          const tx = {
            get: async (ref: any) => ({
              exists: store[ref.path] != null,
              data: () => store[ref.path] ?? undefined,
            }),
            set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
              store[ref.path] = opts?.merge ? { ...(store[ref.path] ?? {}), ...data } : data;
              if (ref.path === 'families/3') familyWrites.push(data);
            },
            update: () => {},
            delete: () => {},
            create: (ref: any, data: Record<string, unknown>) => {
              store[ref.path] = data;
            },
          };
          return await fn(tx);
        } finally {
          release();
        }
      },
    };
    mocks.dbFn.mockReturnValue(customDb);

    const { redeemCreditHandler } = await import('../src/portal/redeemCredit');
    const call = () =>
      redeemCreditHandler({
        data: { invoiceId: 'inv-race', target: 'accountBalance' },
        auth: { uid: 'u1' },
      } as any);

    const results = await Promise.allSettled([call(), call()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one redeem wins; the other re-reads the committed stamp and fails.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'failed-precondition',
      message: 'Credit already redeemed.',
    });

    // The credit applied ONCE: balance 1000 -> 3550, single family write.
    expect(familyWrites).toHaveLength(1);
    expect((familyWrites[0].accountBalanceCents as number)).toBe(3550); // absolute, computed in-tx
    expect((store['families/3'] as Record<string, unknown>).accountBalanceCents).toBe(3550);
    expect((fulfilled[0] as PromiseFulfilledResult<any>).value.newAccountBalanceCents).toBe(3550);
  });
});
