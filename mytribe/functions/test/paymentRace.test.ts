import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2269 and #2230: EVERY PATH THAT PUTS MONEY ON AN INVOICE DECIDES THE NEW
 * BALANCE FROM WHAT ITS OWN TRANSACTION READ.
 *
 * The interleaves below are real: `installOptimisticTransactions` buffers each
 * attempt's writes until commit and re-runs the attempt when a document it read
 * changed underneath it, and its awaited `onRead` hook runs a SECOND HANDLER,
 * for real, in the window between the first handler reading the invoice and
 * committing. That is the window #2269 is about: two staff, or two devices,
 * recording against one invoice at the same moment.
 *
 * Before #2269 `markInvoicePaid` and `recordPayment`'s apply worked the new
 * balance out from a read taken outside their transaction, so the attempt that
 * re-ran after the conflict wrote the same stale figure again.
 */

const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  beforeRepairPlan: null as null | (() => void),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => hooks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', async () => ({
  // The credit draw seals its Activity Log line inside its own transaction, so
  // the chain helpers stay real; only the after-commit writer is stubbed.
  ...(await vi.importActual<object>('../src/lib/writeAuditEntry')),
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({ resolveBillingRecipientUid: async () => 'kin-uid-1' }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: vi.fn().mockResolvedValue([]),
  enqueueNotificationDetailed: async (args: unknown) => hooks.enqueue(args),
}));
vi.mock('../src/lib/invoicePaymentRepair', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/invoicePaymentRepair')>('../src/lib/invoicePaymentRepair');
  return {
    ...actual,
    repairPlanFor: (...args: Parameters<typeof actual.repairPlanFor>) => {
      // Lets a test land a payment between the pass finding a candidate and
      // writing its repair.
      const hook = hooks.beforeRepairPlan;
      hooks.beforeRepairPlan = null;
      hook?.();
      return actual.repairPlanFor(...args);
    },
  };
});
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
      delete: () => undefined,
    },
  };
});

import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { recordPaymentHandler } from '../src/admin/recordPayment';
import { applyAccountCreditHandler } from '../src/admin/applyAccountCredit';
import { writeOffInvoiceHandler } from '../src/admin/archiveInvoice';
import { repairInvoicePaymentsHandler } from '../src/admin/repairInvoicePayments';
import { sweepAbandonedSettlements, settlementLedgerRowId } from '../src/lib/settlementLedgerSweep';
import {
  PAYMENT_APPLIED_CLAIM_FIELD,
  SETTLEMENT_LEDGER_PENDING_AT_FIELD,
  SETTLEMENT_LEDGER_PENDING_FIELD,
  SETTLEMENT_LEDGER_SWEEP_GRACE_MS,
} from '../src/lib/paymentAppliedOwner';

type Docs = Record<string, Record<string, any> | null>;
let docs: Docs;
let ctx: ReturnType<typeof buildDbMock>;

const INVOICE = 'invoices/inv1';
const OPEN = {
  kinfolkId: 'fam1',
  kinfolkName: 'The Riveras',
  client: 'Ana Rivera',
  status: 'open',
  invoiceNumber: '1029',
  total: 40,
  totalCents: 4000,
  amountDue: 40,
  amountDueCents: 4000,
};

beforeEach(() => {
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.beforeRepairPlan = null;
  docs = { [INVOICE]: { ...OPEN }, 'families/fam1': { accountBalanceCents: 12000 } };
  ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
});

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const ipay = (n: number) => `ipay_176300000000${n}_abc12${n}`;
const pay = (n: number) => `pay_176300000000${n}_def45${n}`;

/** What the invoice's own payment rows add up to, the figure the balance must agree with. */
function subcollectionPaidCents(): number {
  return Object.entries(docs)
    .filter(([p, d]) => p.startsWith(`${INVOICE}/payments/`) && d != null)
    .reduce((sum, [, d]) => sum + (d!.amountCents as number), 0);
}

function subcollectionRows(): number {
  return Object.keys(docs).filter((p) => p.startsWith(`${INVOICE}/payments/`) && docs[p] != null).length;
}

/** The invoice agrees with its payments: paid is their sum and due is the total less it. */
function expectBalanceMatchesPayments() {
  const inv = docs[INVOICE]!;
  const paid = subcollectionPaidCents();
  expect(inv.paidCents).toBe(paid);
  expect(inv.amountDueCents).toBe(Math.max(0, inv.totalCents - paid));
}

/**
 * Runs `competitor` for real the first time `first` reads the invoice doc, so
 * it commits inside `first`'s window.
 */
function landInsideWindow(competitor: () => Promise<unknown>) {
  let fired = false;
  const outcome: { value?: unknown; error?: unknown } = {};
  const tx = installOptimisticTransactions(ctx.db, docs, {
    onRead: async (path) => {
      if (fired || path !== INVOICE) return;
      fired = true;
      try {
        outcome.value = await competitor();
      } catch (err) {
        outcome.error = err;
      }
    },
  });
  return { tx, outcome, fired: () => fired };
}

const oneCall = (over: Record<string, unknown> = {}) => ({
  kinfolkId: 'fam1',
  kinfolkName: 'The Riveras',
  client: 'Ana Rivera',
  date: '2026-11-13',
  paymentMethod: 'venmo',
  referenceNumber: 'VN-1',
  amount: 15,
  invoiceId: 'inv1',
  invoiceNumber: '1029',
  apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: 15 },
  idempotencyKey: pay(1),
  ...over,
});

describe('#2269: two payments recorded on one invoice at the same moment', () => {
  it('two partial markInvoicePaid calls both land, and the balance is total minus both', async () => {
    const race = landInsideWindow(() =>
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 10, idempotencyKey: ipay(2) }, 'admin2')),
    );

    const first = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(1) }));

    expect(race.fired()).toBe(true);
    expect(race.outcome.error).toBeUndefined();
    expect(race.outcome.value).toMatchObject({ state: 'partial', paidCents: 1000, amountDueCents: 3000 });
    // The first payment re-ran against the second one's commit.
    expect(first).toMatchObject({ state: 'partial', paidCents: 2500, amountDueCents: 1500 });
    expect(race.tx.attempts()).toBeGreaterThanOrEqual(3);
    expect(subcollectionRows()).toBe(2);
    expect(docs[INVOICE]).toMatchObject({ status: 'open', paidCents: 2500, amountDueCents: 1500, amountDue: 15 });
    expectBalanceMatchesPayments();
  });

  it('two full payments: the second one in is refused as already settled, and only one is recorded', async () => {
    const race = landInsideWindow(() =>
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(2) }, 'admin2')),
    );

    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_already_settled' } });

    expect(race.outcome.value).toMatchObject({ state: 'settled', paidCents: 4000, amountDueCents: 0 });
    expect(subcollectionRows()).toBe(1);
    expect(docs[`${INVOICE}/payments/${ipay(1)}`]).toBeUndefined();
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
    expectBalanceMatchesPayments();
  });

  it('a payment larger than what the other one left is refused over the balance, not booked as overpaid', async () => {
    const race = landInsideWindow(() =>
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 30, idempotencyKey: ipay(2) }, 'admin2')),
    );

    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 20, idempotencyKey: ipay(1) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_amount_exceeds_balance' } });

    expect(race.outcome.value).toMatchObject({ amountDueCents: 1000 });
    expect(docs[INVOICE]).toMatchObject({ paidCents: 3000, amountDueCents: 1000 });
    expectBalanceMatchesPayments();
  });

  it('the one-call Record payment and an older client\'s markInvoicePaid, at once, both land', async () => {
    const race = landInsideWindow(() =>
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 10, idempotencyKey: ipay(2) }, 'admin2')),
    );

    const res = await recordPaymentHandler(req(oneCall()));

    expect(race.outcome.value).toMatchObject({ paidCents: 1000 });
    expect(res.application).toMatchObject({ appliedCents: 1500, state: 'partial', paidCents: 2500, amountDueCents: 1500 });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ appliedInvoiceId: 'inv1', appliedCents: 1500 });
    expect(docs[INVOICE]).toMatchObject({ paidCents: 2500, amountDueCents: 1500 });
    expectBalanceMatchesPayments();
  });

  it('two one-call Record payments that each pay it off: one lands, the other is refused and writes no row', async () => {
    const race = landInsideWindow(() =>
      recordPaymentHandler(req(oneCall({ amount: 40, apply: { invoiceId: 'inv1', amount: 40 }, idempotencyKey: pay(2) }), 'admin2')),
    );

    await expect(
      recordPaymentHandler(req(oneCall({ amount: 40, apply: { invoiceId: 'inv1', amount: 40 } }))),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_already_settled' } });

    expect(race.outcome.value).toMatchObject({ application: { state: 'settled' } });
    expect(docs[`payments/${pay(1)}`]).toBeUndefined();
    expect(docs[`payments/${pay(2)}`]).toMatchObject({ settlesInvoice: true });
    expect(subcollectionRows()).toBe(1);
    expectBalanceMatchesPayments();
    // One payoff, one notice.
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a card payment marking the bill paid inside the window stops the manual payment', async () => {
    // The Stripe webhook's committed write (stripeWebhook.ts, paid branch):
    // the invoice flips paid with nothing owed, and the card money is in the
    // ROOT payments collection, not on the invoice.
    let fired = false;
    installOptimisticTransactions(ctx.db, docs, {
      onRead: (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        docs[INVOICE] = { ...docs[INVOICE], status: 'paid', paymentStatus: 'PAID', amountDue: 0, amountDueCents: 0 };
        docs['payments/evt_1'] = { kinfolkId: 'fam1', invoiceId: 'inv1', amountCents: 4000, stripeEventId: 'evt_1' };
      },
    });

    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_already_paid' } });

    expect(fired).toBe(true);
    expect(subcollectionRows()).toBe(0);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0 });
  });
});

describe('#2269: a credit draw racing a recorded payment', () => {
  const draw = (cents: number) =>
    applyAccountCreditHandler(req({ invoiceId: 'inv1', amountCents: cents, idempotencyKey: 'acr_1790000000000_abc123' }));

  it('a draw landing inside a payment\'s window: both land, and the payment re-plans on the draw', async () => {
    const race = landInsideWindow(() => draw(2500));

    const res = await recordPaymentHandler(req(oneCall({ amount: 10, apply: { invoiceId: 'inv1', amount: 10 } })));

    expect(race.outcome.error).toBeUndefined();
    expect(res.application).toMatchObject({ appliedCents: 1000, paidCents: 3500, amountDueCents: 500 });
    expect(docs['families/fam1']).toMatchObject({ accountBalanceCents: 9500 });
    expect(docs[INVOICE]).toMatchObject({ paidCents: 3500, amountDueCents: 500 });
    expectBalanceMatchesPayments();
  });

  it('a draw that no longer fits after the payment is refused, and the credit is not spent', async () => {
    const race = landInsideWindow(() =>
      recordPaymentHandler(req(oneCall({ amount: 30, apply: { invoiceId: 'inv1', amount: 30 }, idempotencyKey: pay(2) }), 'admin2')),
    );

    await expect(draw(2500)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { reason: 'over_balance', amountDueCents: 1000 },
    });

    expect(race.outcome.value).toMatchObject({ application: { amountDueCents: 1000 } });
    expect(docs['families/fam1']).toMatchObject({ accountBalanceCents: 12000 });
    expect(docs[INVOICE]).toMatchObject({ paidCents: 3000, amountDueCents: 1000 });
    expectBalanceMatchesPayments();
  });
});

describe('#2269: a written-off invoice still refuses a payment', () => {
  it('the one-call Record payment is refused when the write-off commits inside its window', async () => {
    const race = landInsideWindow(() => writeOffInvoiceHandler(req({ invoiceId: 'inv1', amountCents: 4000 }, 'owner1')));

    await expect(recordPaymentHandler(req(oneCall()))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_written_off' },
    });

    expect(race.outcome.error).toBeUndefined();
    expect(docs[INVOICE]).toMatchObject({ status: 'written_off', amountDueCents: 0 });
    expect(docs[`payments/${pay(1)}`]).toBeUndefined();
    expect(subcollectionRows()).toBe(0);
  });

  it('and a written-off invoice refuses it outright', async () => {
    docs[INVOICE] = { ...OPEN, status: 'written_off', amountDue: 0, amountDueCents: 0, writtenOffCents: 4000 };
    await expect(recordPaymentHandler(req(oneCall()))).rejects.toMatchObject({
      details: { code: 'invoice_written_off' },
    });
  });
});

describe('#2269: the repair pass writes from its own transaction', () => {
  it('a payment landing between the pass finding the invoice and repairing it is not overwritten', async () => {
    // The pre-2026-07-25 shape: reads paid with nothing due, while its one
    // recorded payment covers half.
    docs[INVOICE] = { ...OPEN, status: 'paid', amountDue: 0, amountDueCents: 0 };
    docs[`${INVOICE}/payments/old`] = { amount: 20, amountCents: 2000 };
    hooks.beforeRepairPlan = () => {
      // The rest is paid off in the window.
      docs[`${INVOICE}/payments/rest`] = { amount: 20, amountCents: 2000 };
      docs[INVOICE] = { ...docs[INVOICE], status: 'paid', paidCents: 4000, amountDue: 0, amountDueCents: 0 };
    };

    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));

    expect(res.repaired).toBe(0);
    expect(res.skipped.payments_cover_total).toBe(1);
    // Still paid off. The stale plan would have reopened it with $20 owed.
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0 });
  });
});

describe('#2230: an older admin client stops between its two calls', () => {
  const later = () => Date.now() + SETTLEMENT_LEDGER_SWEEP_GRACE_MS + 1000;
  const settleRow = settlementLedgerRowId(ipay(1));

  it('the payoff stamps a pending settlement, and the sweep writes the ledger row and the payoff notice once', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, method: 'cash', reference: 'R-9', idempotencyKey: ipay(1) }));
    // The app is reloaded here: no `recordPayment`.
    expect(docs[INVOICE]).toMatchObject({
      status: 'paid',
      [SETTLEMENT_LEDGER_PENDING_FIELD]: `markInvoicePaid:${ipay(1)}`,
    });
    expect(typeof docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_AT_FIELD]).toBe('number');
    expect(hooks.enqueue).not.toHaveBeenCalled();

    // Still inside the grace: the second call may yet come.
    expect(await sweepAbandonedSettlements(ctx.db as never, Date.now())).toBe(0);
    expect(docs[`payments/${settleRow}`]).toBeUndefined();

    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(docs[`payments/${settleRow}`]).toMatchObject({
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      invoiceNumber: '1029',
      amountCents: 4000,
      appliedCents: 4000,
      paymentMethod: 'cash',
      referenceNumber: 'R-9',
      settledByInvoicePaymentId: ipay(1),
      settlesInvoice: true,
      recordedBy: 'admin1',
      tipBasis: 'unknown',
    });
    // The unticked payoff (#1973): the household's list only, and the office.
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(hooks.enqueue.mock.calls[0]![0]).toMatchObject({
      key: 'invoice.payment.applied',
      recipientUid: 'kin-uid-1',
      listOnlyFor: ['kin-uid-1'],
      data: { invoiceId: 'inv1', paymentId: settleRow },
    });
    expect(docs[INVOICE]).toMatchObject({
      [SETTLEMENT_LEDGER_PENDING_FIELD]: '',
      [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null,
      [PAYMENT_APPLIED_CLAIM_FIELD]: `markInvoicePaid:${ipay(1)}`,
    });
    // The money did not move again.
    expect(docs[INVOICE]).toMatchObject({ paidCents: 4000, amountDueCents: 0 });

    // A second run finds nothing to do.
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(Object.keys(docs).filter((p) => p.startsWith('payments/'))).toEqual([`payments/${settleRow}`]);
  });

  it('a notice that fails is left pending and sent on the next run, with no second ledger row', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    hooks.enqueue.mockRejectedValueOnce(Object.assign(new Error('UNAVAILABLE'), { code: 'unavailable' }));

    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(docs[`payments/${settleRow}`]).toMatchObject({ amountCents: 4000 });
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe(`markInvoicePaid:${ipay(1)}`);

    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(2);
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe('');
    expect(Object.keys(docs).filter((p) => p.startsWith('payments/'))).toEqual([`payments/${settleRow}`]);
  });

  it('when the second call does come, it clears the stamp and the sweep leaves the invoice alone', async () => {
    const settled = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    await recordPaymentHandler(
      req({
        kinfolkId: 'fam1',
        amount: 40,
        invoiceId: 'inv1',
        invoiceNumber: '1029',
        settledByInvoicePaymentId: settled.paymentId,
        idempotencyKey: pay(1),
      }),
    );
    expect(docs[INVOICE]).toMatchObject({
      [SETTLEMENT_LEDGER_PENDING_FIELD]: '',
      [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null,
      [PAYMENT_APPLIED_CLAIM_FIELD]: `markInvoicePaid:${ipay(1)}`,
    });
    const sentBySecondCall = hooks.enqueue.mock.calls.length;
    expect(sentBySecondCall).toBe(1);

    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(hooks.enqueue).toHaveBeenCalledTimes(sentBySecondCall);
    expect(docs[`payments/${settleRow}`]).toBeUndefined();
  });

  it('retrying both old calls with their keys records one settlement row and one ledger row', async () => {
    const step2 = (paymentId: string) =>
      recordPaymentHandler(
        req({ kinfolkId: 'fam1', amount: 40, invoiceId: 'inv1', settledByInvoicePaymentId: paymentId, idempotencyKey: pay(1) }),
      );
    const a = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    const b = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    expect(b).toEqual(a);
    await step2(a.paymentId);
    await step2(a.paymentId);

    expect(subcollectionRows()).toBe(1);
    expect(Object.keys(docs).filter((p) => p.startsWith('payments/'))).toEqual([`payments/${pay(1)}`]);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expectBalanceMatchesPayments();
  });

  it('a partial settlement stamps nothing for the sweep', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(1) }));
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBeUndefined();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
  });

  it('the one-call Record payment never leaves a pending settlement', async () => {
    await recordPaymentHandler(req(oneCall({ amount: 40, apply: { invoiceId: 'inv1', amount: 40 } })));
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBeUndefined();
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ settlesInvoice: true, appliedCents: 4000 });
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
  });
});
