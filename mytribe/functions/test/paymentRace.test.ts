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
  deliver: vi.fn(),
  billingUid: vi.fn(),
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
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({
  resolveBillingRecipientUid: async (...a: unknown[]) => hooks.billingUid(...a),
}));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: vi.fn().mockResolvedValue([]),
  enqueueNotificationDetailed: async (args: unknown) => hooks.enqueue(args),
  deliverListedCopy: async (args: unknown) => hooks.deliver(args),
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
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import {
  SETTLEMENT_LEDGER_MAX_ATTEMPTS,
  ledgerDateOf,
  sweepAbandonedSettlements,
  settlementLedgerRowId,
} from '../src/lib/settlementLedgerSweep';
import {
  PAYMENT_APPLIED_CLAIM_FIELD,
  PAYMENT_APPLIED_OWNER_AT_FIELD,
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
  hooks.billingUid.mockReset();
  hooks.billingUid.mockResolvedValue('kin-uid-1');
  hooks.deliver.mockReset();
  hooks.deliver.mockResolvedValue({ outcome: 'sent', channels: ['email'] });
  vi.mocked(writeAuditEntry).mockClear();
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

describe('#2299: a blank Amount pays what the invoice owes as the server reads it', () => {
  /** Record payment with Amount left blank: the intent, and only what was typed. */
  const settle = (over: Record<string, unknown> = {}) =>
    recordPaymentHandler(
      req(oneCall({ amount: 0, apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: 0, settleBalance: true }, ...over })),
    );
  const ledgerRow = () => docs[`payments/${pay(1)}`];
  /** The refusal's own details, or null when the call did not refuse. */
  const refusalOf = async (call: Promise<unknown>) => {
    try {
      await call;
      return null;
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
      return { status: e.code, message: e.message ?? '', ...(e.details ?? {}) } as Record<string, unknown>;
    }
  };
  const nothingRecorded = (paidCents: number) => {
    expect(ledgerRow()).toBeUndefined();
    expect(subcollectionPaidCents()).toBe(paidCents);
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
    expect(hooks.enqueue).not.toHaveBeenCalled();
  };
  it('every box blank: the whole balance is recorded and the invoice is paid', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const res = await settle();
    expect(res).toMatchObject({ amountCents: 4000, tipCents: 0, appliedCents: 4000, unappliedCents: 0, creditedToAccountCents: 0 });
    expect(res.application).toMatchObject({ appliedCents: 4000, state: 'settled', amountDueCents: 0 });
    expect(ledgerRow()).toMatchObject({ amount: 40, tip: 0, amountCents: 4000, tipCents: 0, appliedCents: 4000, settlesInvoice: true });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
    expectBalanceMatchesPayments();
  });
  it('the screen never loaded the payments: what is left is recorded, not $0 and not the old figure', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(2) }));
    // The older dollar balance the panel would have fallen back on.
    docs[INVOICE]!.amountDue = 0;
    const res = await settle();
    expect(res).toMatchObject({ amountCents: 2500, appliedCents: 2500, tipCents: 0 });
    expect(res.application).toMatchObject({ appliedCents: 2500, state: 'settled', paidCents: 4000 });
    expect(ledgerRow()).toMatchObject({ amount: 25, amountCents: 2500 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
    expectBalanceMatchesPayments();
  });
  it('another payment landing inside its window: it settles what that one left', async () => {
    const { outcome, fired } = landInsideWindow(() =>
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(2) })),
    );
    const res = await settle();
    expect(fired()).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(res).toMatchObject({ amountCents: 2500, appliedCents: 2500 });
    expect(ledgerRow()).toMatchObject({ amount: 25, amountCents: 2500, appliedCents: 2500 });
    expect(subcollectionRows()).toBe(2);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
    expectBalanceMatchesPayments();
  });
  it('a typed tip and fee ride on top of the balance: gross tip stored, fee out of the proceeds', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const res = await settle({ tip: 5, fee: 1.5 });
    expect(res).toMatchObject({ amountCents: 4500, tipCents: 500, feeCents: 150, appliedCents: 4000, proceedsCents: 4350, tipNetCents: 350 });
    expect(ledgerRow()).toMatchObject({ amount: 45, tip: 5, fee: 1.5, tipBasis: 'gross', amountCents: 4500, tipCents: 500, feeCents: 150 });
  });
  it('a typed payment amount with the tip blank: the rest is tip, and credit is only what was entered', async () => {
    const tx = installOptimisticTransactions(ctx.db, docs);
    const res = await settle({ amount: 50, autoApply: true, creditToAccountCents: 300 });
    expect(res).toMatchObject({ amountCents: 5000, appliedCents: 4000, tipCents: 700, unappliedCents: 300, creditedToAccountCents: 300 });
    expect(ledgerRow()).toMatchObject({ amount: 50, tip: 7, tipCents: 700, creditedToAccountCents: 300 });
    // The mock stores the increment itself: one credit of exactly $3.00.
    expect(docs['families/fam1']!.accountBalanceCents).toEqual({ __increment: 300 });
    // A same-key retry is answered from the row: no second credit, no second payment.
    expect(await settle({ amount: 50, autoApply: true, creditToAccountCents: 300 })).toEqual(res);
    expect(tx.committed().filter((p) => p === 'families/fam1')).toHaveLength(1);
    expect(subcollectionRows()).toBe(1);
  });
  it('a typed payment amount and a typed tip that add up are stored as typed', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const res = await settle({ amount: 45, tip: 5 });
    expect(res).toMatchObject({ amountCents: 4500, tipCents: 500, appliedCents: 4000, unappliedCents: 0 });
  });
  it('a typed tip that no longer adds up is refused with what is owed now, and is not rewritten', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(2) }));
    hooks.enqueue.mockClear();
    // Typed against the $40 the panel still showed.
    const refusal = await refusalOf(settle({ amount: 45, tip: 5 }));
    expect(refusal).toMatchObject({ status: 'failed-precondition', code: 'settle_split_mismatch', amountDueCents: 2500 });
    expect(refusal!.message).toContain('$25.00');
    expect(refusal!.message).not.toContain('inv1');
    nothingRecorded(1500);
  });
  it('a payment amount smaller than the balance is refused, never booked as a part payment', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const refusal = await refusalOf(settle({ amount: 30 }));
    expect(refusal).toMatchObject({ status: 'failed-precondition', code: 'settle_payment_short', amountDueCents: 4000 });
    expect(refusal!.message).toContain('$40.00');
    nothingRecorded(0);
    expect(docs[INVOICE]).toMatchObject({ status: 'open', amountDueCents: 4000 });
  });
  it('account credit that the payment amount cannot hold is refused', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const refusal = await refusalOf(settle({ amount: 42, autoApply: true, creditToAccountCents: 500 }));
    expect(refusal).toMatchObject({ code: 'settle_payment_short', amountDueCents: 4000 });
    nothingRecorded(0);
  });
  it('an invoice already paid in full is refused as settled, with nothing owed', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(2) }));
    hooks.enqueue.mockClear();
    const refusal = await refusalOf(settle());
    expect(refusal).toMatchObject({ status: 'failed-precondition', code: 'invoice_already_settled', amountDueCents: 0 });
    nothingRecorded(4000);
  });
  it('a written-off invoice and a draft still refuse', async () => {
    installOptimisticTransactions(ctx.db, docs);
    Object.assign(docs[INVOICE]!, { status: 'draft' });
    expect(await refusalOf(settle())).toMatchObject({ code: 'apply_invoice_not_sent' });
    Object.assign(docs[INVOICE]!, { status: 'open', writtenOffAt: '2026-11-01T00:00:00.000Z', writtenOffCents: 4000, archivedAt: '2026-11-01T00:00:00.000Z' });
    expect(await refusalOf(settle())).toMatchObject({ code: 'invoice_written_off' });
    nothingRecorded(0);
  });
  it('another household\'s invoice is refused', async () => {
    installOptimisticTransactions(ctx.db, docs);
    expect(await refusalOf(settle({ kinfolkId: 'fam2' }))).toMatchObject({ code: 'apply_wrong_household' });
    expect(ledgerRow()).toBeUndefined();
  });
  it('the intent together with an amount is refused before anything is read', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const refusal = await refusalOf(
      settle({ apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: 15, settleBalance: true } }),
    );
    expect(refusal).toMatchObject({ status: 'invalid-argument', code: 'settle_balance_with_amount' });
    nothingRecorded(0);
  });
  it('without the intent a zero apply is still refused: the server never guesses that blank was meant', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const refusal = await refusalOf(
      recordPaymentHandler(req(oneCall({ amount: 0, apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: 0 } }))),
    );
    expect(refusal).toMatchObject({ code: 'apply_zero_amount' });
    nothingRecorded(0);
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

  it('the ledger row is dated on the business day, not the UTC day, for an evening payment', async () => {
    // 7:30 PM on the 13th in Chicago is already the 14th in UTC.
    await markInvoicePaidHandler(
      req({ invoiceId: 'inv1', amount: 40, paidAt: '2026-11-14T01:30:00.000Z', idempotencyKey: ipay(1) }),
    );
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(docs[`payments/${settleRow}`]).toMatchObject({ date: '2026-11-13' });
  });

  it('reads the business day off every stored shape of the paid time', () => {
    // Summer: Chicago is five hours behind UTC, so 11:30 PM on the 3rd is 04:30 UTC on the 4th.
    expect(ledgerDateOf('2026-07-04T04:30:00.000Z')).toBe('2026-07-03');
    expect(ledgerDateOf('2026-11-13T18:00:00.000Z')).toBe('2026-11-13');
    // A bare day and a wall-clock time with no zone keep their own date.
    expect(ledgerDateOf('2026-11-13')).toBe('2026-11-13');
    expect(ledgerDateOf('2026-11-13T23:45:00')).toBe('2026-11-13');
    expect(ledgerDateOf('yesterday')).toBe('');
    expect(ledgerDateOf(undefined)).toBe('');
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

/**
 * #2281 review: THE SWEEP'S ROW AND A LATE SECOND CALL ARE ONE PAYMENT.
 *
 * The sweep writes `payments/settle_<id>` for a settlement nobody finished. A
 * second call that arrives after it (the operator pressing Record again on a
 * tab whose first reply was lost, or a row added by hand for the same invoice)
 * used to write its own row beside the sweep's, so the ledger counted the
 * payment twice. The caller's row carries the tip, the fee and any credit; the
 * sweep's row does not. So the caller's row takes the sweep row's place in one
 * commit, and keeps its notice stamps.
 */
describe('#2281 review: a second call that arrives after the sweep', () => {
  const later = () => Date.now() + SETTLEMENT_LEDGER_SWEEP_GRACE_MS + 1000;
  const settleRow = settlementLedgerRowId(ipay(1));
  const ledgerRows = () => Object.keys(docs).filter((p) => p.startsWith('payments/') && docs[p] != null);
  const step1 = () =>
    markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, method: 'venmo', reference: 'VN-9', idempotencyKey: ipay(1) }));
  /** Step 2 as an installed two-call build sends it: the whole transaction, tip and fee included. */
  const step2 = (settlementId: string, over: Record<string, unknown> = {}) =>
    recordPaymentHandler(
      req({
        kinfolkId: 'fam1',
        kinfolkName: 'The Riveras',
        client: 'Ana Rivera',
        date: '2026-11-13',
        paymentMethod: 'venmo',
        referenceNumber: 'VN-9',
        amount: 45,
        tip: 5,
        fee: 1.5,
        invoiceId: 'inv1',
        invoiceNumber: '1029',
        settledByInvoicePaymentId: settlementId,
        sendConfirmationEmail: true,
        idempotencyKey: pay(1),
        ...over,
      }),
    );
  /** A row added by hand for the invoice: linked to it, no settlement id, no apply. */
  const handRow = (over: Record<string, unknown> = {}) =>
    recordPaymentHandler(
      req({
        kinfolkId: 'fam1',
        date: '2026-11-13',
        paymentMethod: 'venmo',
        amount: 45,
        tip: 5,
        invoiceId: 'inv1',
        invoiceNumber: '1029',
        idempotencyKey: pay(2),
        ...over,
      }),
    );
  /** Moves the settlement's stamp back, so a call with no settlement id is past the old-client claim window. */
  const ageSettlement = (ms: number) => {
    docs[INVOICE]![PAYMENT_APPLIED_OWNER_AT_FIELD] -= ms;
  };
  it('the late retry leaves one ledger row with the caller\'s amounts, and no second list entry or office copy', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    // The reply is lost. Ten minutes on, the sweep finishes the settlement.
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(ledgerRows()).toEqual([`payments/${settleRow}`]);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    // The operator presses Record again with the same form: both calls, same keys.
    expect(await step1()).toEqual(settled);
    const first = await step2(settled.paymentId);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs[`payments/${pay(1)}`]).toMatchObject({
      amountCents: 4500,
      tipCents: 500,
      feeCents: 150,
      tipBasis: 'gross',
      appliedCents: 4000,
      unappliedCents: 0,
      proceedsCents: 4350,
      settledByInvoicePaymentId: ipay(1),
      settlesInvoice: true,
      recordedBy: 'admin1',
      // The sweep's office stamp came across with the row.
      officeNoticeSentAt: '__TS__',
      replacedSettlementLedgerRowId: settleRow,
    });
    expect(first).toMatchObject({ paymentId: pay(1), amountCents: 4500, tipCents: 500, feeCents: 150, appliedCents: 4000 });
    // The household's list and the office were told once, by the sweep: nothing
    // is enqueued again.
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    // The admin ticked Send Confirmation on this call, and the sweep had only
    // listed the payoff. The listed copy is sent on the household's channels,
    // once, under the sweep row's identity.
    expect(hooks.deliver).toHaveBeenCalledTimes(1);
    expect(hooks.deliver.mock.calls[0]![0]).toEqual({
      key: 'invoice.payment.applied',
      recipientUid: 'kin-uid-1',
      data: { kinfolkId: 'fam1', invoiceId: 'inv1', paymentId: settleRow },
    });
    expect(first).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false, officeNoticePending: false });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
    // The money did not move again.
    expect(docs[INVOICE]).toMatchObject({ paidCents: 4000, amountDueCents: 0, [SETTLEMENT_LEDGER_PENDING_FIELD]: '' });
    expect(subcollectionRows()).toBe(1);
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
    // A second retry by the same key is answered from the row, and emails nothing more.
    expect(await step2(settled.paymentId)).toEqual(first);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(hooks.deliver).toHaveBeenCalledTimes(1);
    // And the sweep has nothing left to do.
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
  });
  it('an unticked late retry emails nothing: the sweep\'s list entry stands', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    const first = await step2(settled.paymentId, { sendConfirmationEmail: false });
    expect(hooks.deliver).not.toHaveBeenCalled();
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
  });
  it('a ticked late retry for a household with every channel off stays list only, and says so', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    hooks.deliver.mockResolvedValue({ outcome: 'no-channels', channels: [] });
    const first = await step2(settled.paymentId);
    expect(first).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
  });
  it('a ticked email that fails is sent by the next same-key retry, and never twice', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    hooks.deliver.mockRejectedValueOnce(Object.assign(new Error('UNAVAILABLE'), { code: 'unavailable' }));
    const first = await step2(settled.paymentId);
    // The payment is recorded; the email did not go, and the answer says so.
    // Not "app only": the clients print that as the household having email and
    // text off, and here the send failed.
    expect(first).toMatchObject({ paymentId: pay(1), confirmationEmailSent: false });
    expect(first).not.toHaveProperty('confirmationAppOnly');
    // The row still records the listed copy, which is what lets the retry try again.
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
    const second = await step2(settled.paymentId);
    expect(second).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
    expect(hooks.deliver).toHaveBeenCalledTimes(2);
    expect(await step2(settled.paymentId)).toEqual(second);
    expect(hooks.deliver).toHaveBeenCalledTimes(2);
    // Throughout: one list entry and one office copy, both the sweep's.
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  it('a copy the sweep sent and could not stamp is not reported as emailed unless it is', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    // The sweep's stamp on its row was lost. The dispatcher's ledger still
    // knows both copies went out, and refuses them as duplicates.
    delete docs[`payments/${settleRow}`]!.confirmationAppOnly;
    delete docs[`payments/${settleRow}`]!.officeNoticeSentAt;
    hooks.enqueue.mockResolvedValue({
      written: [],
      suppressed: [
        { recipientUid: 'kin-uid-1', reason: 'duplicate' },
        { recipientUid: 'office-1', reason: 'duplicate' },
      ],
      unresolved: [],
    });
    hooks.deliver.mockResolvedValue({ outcome: 'no-channels', channels: [] });
    const first = await step2(settled.paymentId);
    // The duplicate is the sweep's list entry, not an email.
    expect(first).toMatchObject({ confirmationEmailSent: false, confirmationAppOnly: true });
    expect(hooks.deliver).toHaveBeenCalledTimes(1);
    hooks.deliver.mockResolvedValue({ outcome: 'sent', channels: ['email'] });
    expect(await step2(settled.paymentId)).toMatchObject({ confirmationEmailSent: true, confirmationAppOnly: false });
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  it('a late retry after an edit reopened the invoice still leaves one ledger row', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    // A line was added: the invoice is open again with a balance.
    Object.assign(docs[INVOICE]!, { status: 'open', totalCents: 5000, amountDueCents: 1000 });
    await step2(settled.paymentId, { sendConfirmationEmail: false });
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ amountCents: 4500, tipCents: 500, replacedSettlementLedgerRowId: settleRow });
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
  });
  it('and when that retry lands before the sweep, the sweep writes no second row', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    Object.assign(docs[INVOICE]!, { status: 'open', totalCents: 5000, amountDueCents: 1000 });
    await step2(settled.paymentId, { sendConfirmationEmail: false });
    expect(docs[INVOICE]).toMatchObject({ [SETTLEMENT_LEDGER_PENDING_FIELD]: '', [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null });
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  // Third review of c4b12f31: what the reopened-invoice branch must NOT do.
  it('a call naming another invoice\'s settlement replaces neither invoice\'s sweep row', async () => {
    installOptimisticTransactions(ctx.db, docs);
    docs['invoices/inv2'] = { ...OPEN, invoiceNumber: '1030' };
    await step1();
    await markInvoicePaidHandler(req({ invoiceId: 'inv2', amount: 40, method: 'venmo', idempotencyKey: ipay(3) }));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(2);
    const other = settlementLedgerRowId(ipay(3));
    const before = { mine: { ...docs[`payments/${settleRow}`]! }, theirs: { ...docs[`payments/${other}`]! } };
    // Linked to inv1, naming the settlement that paid inv2.
    await step2(ipay(3), { sendConfirmationEmail: false });
    expect(docs[`payments/${settleRow}`]).toEqual(before.mine);
    expect(docs[`payments/${other}`]).toEqual(before.theirs);
    expect(ledgerRows().sort()).toEqual([`payments/${pay(1)}`, `payments/${settleRow}`, `payments/${other}`].sort());
    expect(docs[`payments/${pay(1)}`]!.replacedSettlementLedgerRowId).toBeUndefined();
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ settlesInvoice: false, settledByInvoicePaymentId: '' });
    expect(hooks.deliver).not.toHaveBeenCalled();
  });
  it('a call for another household naming this settlement is refused and leaves the sweep row alone', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    const before = { ...docs[`payments/${settleRow}`]! };
    const invoiceBefore = { ...docs[INVOICE]! };
    await expect(step2(settled.paymentId, { kinfolkId: 'fam2', sendConfirmationEmail: false })).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'link_wrong_household' },
    });
    expect(docs[`payments/${settleRow}`]).toEqual(before);
    expect(docs[INVOICE]).toEqual(invoiceBefore);
    expect(docs[`payments/${pay(1)}`]).toBeUndefined();
  });
  it('after a reopen and a second payoff, the late retry replaces only its own settlement\'s row and takes nothing from the later one', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    // A line was added, and an older build paid the new balance off and stopped.
    Object.assign(docs[INVOICE]!, { status: 'open', total: 50, totalCents: 5000, amountDue: 10, amountDueCents: 1000 });
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 10, method: 'cash', idempotencyKey: ipay(2) }));
    const laterOwner = `markInvoicePaid:${ipay(2)}`;
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', [SETTLEMENT_LEDGER_PENDING_FIELD]: laterOwner });
    const claimBefore = docs[INVOICE]![PAYMENT_APPLIED_CLAIM_FIELD];
    hooks.enqueue.mockClear();
    await step2(settled.paymentId, { sendConfirmationEmail: false });
    // Its own settlement's stand-in is replaced; the invoice still waits on the later payoff.
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ amountCents: 4500, replacedSettlementLedgerRowId: settleRow });
    expect(docs[INVOICE]).toMatchObject({ [SETTLEMENT_LEDGER_PENDING_FIELD]: laterOwner });
    expect(docs[INVOICE]![PAYMENT_APPLIED_CLAIM_FIELD]).toBe(claimBefore);
    expect(docs[INVOICE]![PAYMENT_APPLIED_CLAIM_FIELD]).not.toBe(laterOwner);
    // The sweep had told everyone about the first payoff: the late call tells nobody again.
    expect(hooks.enqueue).not.toHaveBeenCalled();
    // The sweep then finishes the later payoff under its own row.
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(ledgerRows().sort()).toEqual([`payments/${pay(1)}`, `payments/${settlementLedgerRowId(ipay(2))}`].sort());
    expect(docs[`payments/${settlementLedgerRowId(ipay(2))}`]).toMatchObject({ amountCents: 1000 });
    expect(subcollectionRows()).toBe(2);
  });
  it('a credit the admin entered on the late retry is given once', async () => {
    const tx = installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    const over = { amount: 55, creditToAccountCents: 1000 };
    const first = await step2(settled.paymentId, over);
    await step2(settled.paymentId, over);
    expect(first).toMatchObject({ creditedToAccountCents: 1000, appliedCents: 4000, tipCents: 500 });
    expect(docs['families/fam1']!.accountBalanceCents).toEqual({ __increment: 1000 });
    // One write to the balance across both attempts.
    expect(tx.committed().filter((p) => p === 'families/fam1')).toHaveLength(1);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  it('the sweep landing inside the second call\'s window still ends with one row and one notice', async () => {
    const settled = await step1();
    const { tx, fired } = landInsideWindow(() => sweepAbandonedSettlements(ctx.db as never, later()));
    await step2(settled.paymentId);
    expect(fired()).toBe(true);
    expect(tx.attempts()).toBeGreaterThan(1);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ amountCents: 4500, tipCents: 500, settlesInvoice: true });
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
  });
  it('a sweep notice that never went out is sent once by the late retry, under the settlement\'s own identity', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    hooks.enqueue.mockRejectedValueOnce(Object.assign(new Error('UNAVAILABLE'), { code: 'unavailable' }));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe(`markInvoicePaid:${ipay(1)}`);
    const first = await step2(settled.paymentId);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(hooks.enqueue).toHaveBeenCalledTimes(2);
    // The same identity the sweep sends under, so the dispatcher's ledger
    // catches a copy the sweep got out before it could stamp the row.
    expect(hooks.enqueue.mock.calls[1]![0]).toMatchObject({
      key: 'invoice.payment.applied',
      data: { invoiceId: 'inv1', paymentId: settleRow },
    });
    expect(first.confirmationEmailSent).toBe(true);
    expect(docs[INVOICE]).toMatchObject({ [SETTLEMENT_LEDGER_PENDING_FIELD]: '', [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null });
    // Nothing further from a retry or from the sweep.
    await step2(settled.paymentId);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(hooks.enqueue).toHaveBeenCalledTimes(2);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  it('a late retry whose own send fails finishes it on the next retry, still under the settlement\'s identity', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    // Neither the sweep's send nor the late retry's own gets out.
    hooks.enqueue.mockRejectedValueOnce(Object.assign(new Error('UNAVAILABLE'), { code: 'unavailable' }));
    hooks.enqueue.mockRejectedValueOnce(Object.assign(new Error('UNAVAILABLE'), { code: 'unavailable' }));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    const first = await step2(settled.paymentId);
    expect(first).toMatchObject({ confirmationEmailSent: false, officeNoticePending: true });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ noticePaymentId: settleRow, confirmationEmailSent: false });
    const second = await step2(settled.paymentId);
    expect(hooks.enqueue).toHaveBeenCalledTimes(3);
    expect(hooks.enqueue.mock.calls[2]![0]).toMatchObject({ data: { invoiceId: 'inv1', paymentId: settleRow } });
    expect(second.confirmationEmailSent).toBe(true);
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ confirmationEmailSent: true, officeNoticeSentAt: '__TS__' });
    await step2(settled.paymentId);
    expect(hooks.enqueue).toHaveBeenCalledTimes(3);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  it('the sweep writes nothing after a row was added by hand for the settlement', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await step1();
    // Six minutes on: past the old-client claim window, before the sweep.
    ageSettlement(6 * 60 * 1000);
    await handRow();
    expect(docs[INVOICE]).toMatchObject({
      [PAYMENT_APPLIED_CLAIM_FIELD]: `markInvoicePaid:${ipay(1)}`,
      [SETTLEMENT_LEDGER_PENDING_FIELD]: '',
      [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null,
    });
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(ledgerRows()).toEqual([`payments/${pay(2)}`]);
    expect(docs[`payments/${settleRow}`]).toBeUndefined();
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    // It took a settlement nobody had finished: nothing to warn about.
    expect(duplicateWarnings(pay(2))).toEqual([]);
  });
  // #2300: A ROW WITH NO SETTLEMENT ID NEVER DELETES OR REPLACES A LEDGER ROW.
  // After the sweep it cannot be told from a second, separate payment of the
  // same amount, so it is written as its own payment and the owner is warned.
  const duplicateWarnings = (paymentId: string) =>
    vi
      .mocked(writeAuditEntry)
      .mock.calls.map((c) => c[0])
      .filter((a) => a.payload?.['paymentId'] === paymentId && a.payload?.['possibleDuplicateOfPaymentId'] !== undefined);
  it('a row added by hand after the sweep is its own payment: the sweep row stays and the owner is warned', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    const sweepRowBefore = { ...docs[`payments/${settleRow}`]! };
    ageSettlement(60 * 60 * 1000);
    const invoiceBefore = { ...docs[INVOICE]! };
    await handRow();
    expect(ledgerRows().sort()).toEqual([`payments/${pay(2)}`, `payments/${settleRow}`].sort());
    // The sweep's row is exactly as the sweep left it.
    expect(docs[`payments/${settleRow}`]).toEqual(sweepRowBefore);
    const row = docs[`payments/${pay(2)}`]!;
    expect(row).toMatchObject({ amountCents: 4500, tipCents: 500, tipBasis: 'gross', settlesInvoice: false, appliedCents: 0 });
    expect(row.replacedSettlementLedgerRowId).toBeUndefined();
    expect(row.noticePaymentId).toBeUndefined();
    expect(row.officeNoticeSentAt).toBeUndefined();
    // The invoice is not touched: no money moved and the claim is the sweep's.
    expect(docs[INVOICE]).toEqual(invoiceBefore);
    expect(subcollectionRows()).toBe(1);
    // Unticked and paying nothing off: nobody is told again.
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(hooks.deliver).not.toHaveBeenCalled();
    // One Activity Log line, in plain words, with no ids in the sentence.
    const warnings = duplicateWarnings(pay(2));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      severity: 'warn',
      status: 'SUCCESS',
      description: 'A payment was recorded for invoice 1029, which was already settled. Check for a duplicate.',
    });
    expect(warnings[0]!.payload).toMatchObject({ possibleDuplicateOfPaymentId: settleRow, amountCents: 4500 });
    expect(warnings[0]!.description).not.toContain(settleRow);
    expect(warnings[0]!.description).not.toContain(pay(2));
  });
  it('a separate payment of the same amount recorded months later keeps both rows', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    const sweepRowBefore = { ...docs[`payments/${settleRow}`]! };
    // Ninety days on, the household pays the same $40 again and it is recorded
    // against the same invoice, with a confirmation.
    ageSettlement(90 * 24 * 60 * 60 * 1000);
    const second = await handRow({ amount: 40, tip: 0, sendConfirmationEmail: true });
    expect(ledgerRows().sort()).toEqual([`payments/${pay(2)}`, `payments/${settleRow}`].sort());
    expect(docs[`payments/${settleRow}`]).toEqual(sweepRowBefore);
    expect(docs[`payments/${pay(2)}`]).toMatchObject({ amountCents: 4000, settlesInvoice: false });
    expect(docs[`payments/${pay(2)}`]!.replacedSettlementLedgerRowId).toBeUndefined();
    // Its confirmation goes out as its own, under its own id.
    expect(hooks.enqueue).toHaveBeenCalledTimes(2);
    expect(hooks.enqueue.mock.calls[1]![0].data).toMatchObject({ paymentId: pay(2) });
    expect(hooks.deliver).not.toHaveBeenCalled();
    expect(second).toMatchObject({ paymentId: pay(2), amountCents: 4000, confirmationEmailSent: true });
    expect(duplicateWarnings(pay(2))).toHaveLength(1);
    // A same-key retry is answered from the row: no third row, no second warning.
    expect(await handRow({ amount: 40, tip: 0, sendConfirmationEmail: true })).toMatchObject({ paymentId: pay(2) });
    expect(ledgerRows()).toHaveLength(2);
    expect(duplicateWarnings(pay(2))).toHaveLength(1);
    // And the sweep has nothing more to do.
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(ledgerRows()).toHaveLength(2);
  });
  it('the sweep landing inside a hand-added row\'s window: both rows are kept and the owner is warned', async () => {
    await step1();
    ageSettlement(11 * 60 * 1000);
    const { outcome, fired } = landInsideWindow(() => sweepAbandonedSettlements(ctx.db as never, later()));
    await handRow();
    expect(fired()).toBe(true);
    expect(outcome.value).toBe(1);
    expect(ledgerRows().sort()).toEqual([`payments/${pay(2)}`, `payments/${settleRow}`].sort());
    expect(docs[`payments/${settleRow}`]).toMatchObject({ amountCents: 4000, recordedByServer: 'settlementLedgerSweep' });
    expect(docs[`payments/${pay(2)}`]!.replacedSettlementLedgerRowId).toBeUndefined();
    expect(duplicateWarnings(pay(2))).toHaveLength(1);
  });
  it('a smaller row after the sweep gets no warning: it is not a second payoff', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    ageSettlement(60 * 60 * 1000);
    await handRow({ amount: 5, tip: 5 });
    expect(duplicateWarnings(pay(2))).toEqual([]);
  });
  it('a later row linked to the invoice that does not cover the payment leaves the sweep row alone', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    ageSettlement(60 * 60 * 1000);
    // A tip sent the next day, recorded against the same invoice.
    await handRow({ amount: 5, tip: 5 });
    expect(ledgerRows().sort()).toEqual([`payments/${pay(2)}`, `payments/${settleRow}`].sort());
    expect(docs[`payments/${settleRow}`]).toMatchObject({ amountCents: 4000 });
    expect(docs[`payments/${pay(2)}`]).toMatchObject({ amountCents: 500, settlesInvoice: false });
    // The tip row is unticked and paid nothing off: nobody is told again.
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
  });
  it('and before the sweep, the same small row does not stand in for the settlement', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await step1();
    ageSettlement(6 * 60 * 1000);
    await handRow({ amount: 5, tip: 5 });
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe(`markInvoicePaid:${ipay(1)}`);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(ledgerRows().sort()).toEqual([`payments/${pay(2)}`, `payments/${settleRow}`].sort());
  });
  it('an earlier part payment\'s ledger row does not stop the sweep finishing a later payoff', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const part = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(2) }));
    await step2(part.paymentId, { amount: 15, tip: 0, fee: 0, sendConfirmationEmail: false });
    // The payoff's second call never comes.
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 25, idempotencyKey: ipay(1) }));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(ledgerRows().sort()).toEqual([`payments/${pay(1)}`, `payments/${settleRow}`].sort());
    expect(docs[`payments/${settleRow}`]).toMatchObject({ amountCents: 2500, settledByInvoicePaymentId: ipay(1) });
  });
});

describe('#2296: a second call naming a settlement that already has its ledger row', () => {
  const later = () => Date.now() + SETTLEMENT_LEDGER_SWEEP_GRACE_MS + 1000;
  const ledgerRows = () => Object.keys(docs).filter((p) => p.startsWith('payments/') && docs[p] != null);
  const step1 = () => markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, method: 'venmo', idempotencyKey: ipay(1) }));
  /** Step 2 of an installed two-call build. */
  const step2 = (settlementId: string, over: Record<string, unknown> = {}) =>
    recordPaymentHandler(
      req({
        kinfolkId: 'fam1',
        kinfolkName: 'The Riveras',
        client: 'Ana Rivera',
        date: '2026-11-13',
        paymentMethod: 'venmo',
        amount: 45,
        tip: 5,
        invoiceId: 'inv1',
        invoiceNumber: '1029',
        settledByInvoicePaymentId: settlementId,
        idempotencyKey: pay(1),
        ...over,
      }),
    );
  it('a second key is answered from the first row: one row, nothing sent twice, no second credit', async () => {
    const tx = installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    const first = await step2(settled.paymentId, { amount: 55, creditToAccountCents: 1000 });
    expect(first).toMatchObject({ paymentId: pay(1), creditedToAccountCents: 1000 });
    expect(docs[`${INVOICE}/payments/${settled.paymentId}`]).toMatchObject({ ledgerPaymentId: pay(1) });
    const sent = hooks.enqueue.mock.calls.length;
    const second = await step2(settled.paymentId, { amount: 55, creditToAccountCents: 1000, idempotencyKey: pay(2) });
    expect(second).toEqual(first);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs['families/fam1']!.accountBalanceCents).toEqual({ __increment: 1000 });
    // One write to the balance across both calls: the first one's.
    expect(tx.committed().filter((p) => p === 'families/fam1')).toHaveLength(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(sent);
    expect(subcollectionRows()).toBe(1);
    expectBalanceMatchesPayments();
  });
  it('a row from before the stamp existed is still found: no second row, no second credit', async () => {
    const tx = installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    const first = await step2(settled.paymentId);
    // What a row written before this deploy looks like: the settlement does not name it.
    const { ledgerPaymentId: _dropped, ...unstamped } = docs[`${INVOICE}/payments/${settled.paymentId}`]!;
    docs[`${INVOICE}/payments/${settled.paymentId}`] = unstamped;
    const second = await step2(settled.paymentId, { amount: 55, creditToAccountCents: 1000, idempotencyKey: pay(2) });
    expect(second).toEqual(first);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(tx.committed().filter((p) => p === 'families/fam1')).toHaveLength(0);
    expect(subcollectionRows()).toBe(1);
  });
  it('a keyless second call is answered from the first row too', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    await step2(settled.paymentId);
    const again = await step2(settled.paymentId, { idempotencyKey: undefined });
    expect(again).toMatchObject({ paymentId: pay(1) });
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  it('a part payment named twice under two keys keeps one row', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const part = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(2) }));
    await step2(part.paymentId, { amount: 15, tip: 0 });
    await step2(part.paymentId, { amount: 15, tip: 0, idempotencyKey: pay(2) });
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs[INVOICE]).toMatchObject({ paidCents: 1500, amountDueCents: 2500 });
  });
  it('two keys landing at the same moment: the one that re-runs finds the other\'s row', async () => {
    const settled = await step1();
    const { tx, outcome, fired } = landInsideWindow(() =>
      step2(settled.paymentId, { creditToAccountCents: 0, idempotencyKey: pay(2) }),
    );
    const mine = await step2(settled.paymentId);
    expect(fired()).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(tx.attempts()).toBeGreaterThan(2);
    expect(ledgerRows()).toEqual([`payments/${pay(2)}`]);
    expect(mine).toMatchObject({ paymentId: pay(2) });
    expect(docs[`${INVOICE}/payments/${settled.paymentId}`]).toMatchObject({ ledgerPaymentId: pay(2) });
  });
  it('a second key after the late call replaced the sweep row is answered from that row', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    await step2(settled.paymentId);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    const again = await step2(settled.paymentId, { idempotencyKey: pay(2), creditToAccountCents: 0 });
    expect(again).toMatchObject({ paymentId: pay(1) });
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
  });
  it('a second key after a reopen still finds the first row', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    await step2(settled.paymentId);
    // An edit reopened the invoice: the settlement no longer owns its stamp.
    docs[INVOICE] = { ...docs[INVOICE]!, status: 'open', paymentAppliedNoticeOwner: '' };
    await step2(settled.paymentId, { idempotencyKey: pay(2) });
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
  it('a row added by hand, naming no settlement, is still its own payment', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    await step2(settled.paymentId);
    await recordPaymentHandler(
      req({ kinfolkId: 'fam1', date: '2026-11-14', paymentMethod: 'cash', amount: 10, invoiceId: 'inv1', idempotencyKey: pay(3) }),
    );
    expect(ledgerRows().sort()).toEqual([`payments/${pay(1)}`, `payments/${pay(3)}`].sort());
  });
  it('a call for another household naming this settlement is refused: it neither stamps it nor steals its answer', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    await expect(
      step2(settled.paymentId, { kinfolkId: 'fam2', idempotencyKey: pay(3), sendConfirmationEmail: false }),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'link_wrong_household' } });
    expect(docs[`payments/${pay(3)}`]).toBeUndefined();
    expect(docs[`${INVOICE}/payments/${settled.paymentId}`]!['ledgerPaymentId']).toBeUndefined();
    // The right household's call records its own row and is not answered from the other one.
    const mine = await step2(settled.paymentId);
    expect(mine).toMatchObject({ paymentId: pay(1), kinfolkId: 'fam1' });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ kinfolkId: 'fam1', settlesInvoice: true });
    expect(docs[`${INVOICE}/payments/${settled.paymentId}`]).toMatchObject({ ledgerPaymentId: pay(1) });
    // And a second key for the right household is answered from its own row.
    expect(await step2(settled.paymentId, { idempotencyKey: pay(2) })).toMatchObject({ paymentId: pay(1) });
    expect(docs[`payments/${pay(2)}`]).toBeUndefined();
  });

  it('a same-key retry of the first step after the stamp still answers as it did', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    await step2(settled.paymentId);
    expect(await step1()).toEqual(settled);
    expect(subcollectionRows()).toBe(1);
    expectBalanceMatchesPayments();
  });

  it('a stamp naming a row that is gone does not stop the payment being recorded', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await step1();
    docs[`${INVOICE}/payments/${settled.paymentId}`] = {
      ...docs[`${INVOICE}/payments/${settled.paymentId}`]!,
      ledgerPaymentId: 'pay_gone',
    };
    await step2(settled.paymentId);
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
    expect(docs[`${INVOICE}/payments/${settled.paymentId}`]).toMatchObject({ ledgerPaymentId: pay(1) });
  });
});
describe('#2327: the sweep gives up on a settlement whose recipient step keeps failing', () => {
  const later = () => Date.now() + SETTLEMENT_LEDGER_SWEEP_GRACE_MS + 1000;
  const settleRow = settlementLedgerRowId(ipay(1));
  it('it is retried up to the cap, then given up and logged; the ledger row stays', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    hooks.billingUid.mockRejectedValue(Object.assign(new Error('UNAVAILABLE'), { code: 'unavailable' }));
    for (let i = 1; i < SETTLEMENT_LEDGER_MAX_ATTEMPTS; i += 1) {
      expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
      expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe(`markInvoicePaid:${ipay(1)}`);
    }
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(docs[INVOICE]).toMatchObject({
      [SETTLEMENT_LEDGER_PENDING_FIELD]: '',
      [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null,
      settlementLedgerSkippedReason: 'gave-up',
      settlementLedgerAttempts: SETTLEMENT_LEDGER_MAX_ATTEMPTS,
    });
    expect(docs[`payments/${settleRow}`]).toMatchObject({ amountCents: 4000 });
    expect(hooks.enqueue).not.toHaveBeenCalled();
    // Out of the query: the next run does nothing.
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
  });
  it('a lookup that recovers before the cap sends the notice', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    hooks.billingUid.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(1);
    expect(docs[INVOICE]!['settlementLedgerSkippedReason']).toBeUndefined();
  });
});
describe('#2343: the sweep\'s payoff when the household send switch holds the household copy', () => {
  const later = () => Date.now() + SETTLEMENT_LEDGER_SWEEP_GRACE_MS + 1000;
  const settleRow = settlementLedgerRowId(ipay(1));
  const heldOutcome = (gateState: string) => ({
    written: ['n-office'],
    suppressed: [{ recipientUid: 'kin-uid-1', reason: 'gate', gateState }],
    unresolved: [],
  });
  it('switched off: finished, the row says held and does not say the household was told', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    hooks.enqueue.mockResolvedValueOnce(heldOutcome('off'));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(docs[`payments/${settleRow}`]).toMatchObject({
      householdNoticeHeld: 'off',
      officeNoticeSentAt: '__TS__',
      confirmationEmailSent: false,
      confirmationAppOnly: false,
    });
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe('');
  });
  it('and a late second call, with the switch now on, still lists the payoff for the household', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const settled = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    hooks.enqueue.mockResolvedValueOnce(heldOutcome('off'));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
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
    expect(hooks.enqueue).toHaveBeenCalledTimes(2);
    expect(hooks.enqueue.mock.calls[1]![0]).toMatchObject({
      recipientUid: 'kin-uid-1',
      listOnlyFor: ['kin-uid-1'],
      data: { paymentId: settleRow },
    });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ confirmationAppOnly: true });
    // The held note was the sweep row's; the row that took its place has told them.
    expect(docs[`payments/${pay(1)}`]!['householdNoticeHeld']).toBeUndefined();
  });
  it('a switch that could not be read leaves it pending, and the next run tells the household', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    hooks.enqueue.mockResolvedValueOnce(heldOutcome('read-failed'));
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe(`markInvoicePaid:${ipay(1)}`);
    expect(docs[`payments/${settleRow}`]!['householdNoticeHeld']).toBeUndefined();
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(hooks.enqueue).toHaveBeenCalledTimes(2);
    expect(docs[`payments/${settleRow}`]).toMatchObject({ confirmationAppOnly: true });
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe('');
  });
});

describe('a payment links only to its own household\'s invoice', () => {
  const INVOICE2 = 'invoices/inv2';
  /** A row added by hand: a display link to an invoice, nothing applied. */
  const linked = (over: Record<string, unknown> = {}) =>
    recordPaymentHandler(
      req({
        kinfolkId: 'fam2',
        date: '2026-11-14',
        paymentMethod: 'cash',
        amount: 10,
        invoiceId: 'inv1',
        invoiceNumber: '1029',
        sendConfirmationEmail: true,
        idempotencyKey: pay(1),
        ...over,
      }),
    );
  const refusalOf = async (call: Promise<unknown>) => {
    try {
      await call;
      return null;
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
      return { status: e.code, message: e.message ?? '', ...(e.details ?? {}) } as Record<string, unknown>;
    }
  };
  const ledgerRows = () => Object.keys(docs).filter((p) => p.startsWith('payments/') && docs[p] != null);
  const nothingRecordedOrSent = () => {
    expect(ledgerRows()).toEqual([]);
    expect(docs[INVOICE]).toEqual({ ...OPEN });
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
    expect(docs['families/fam2']!.accountBalanceCents).toBe(0);
    expect(hooks.billingUid).not.toHaveBeenCalled();
    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(hooks.deliver).not.toHaveBeenCalled();
  };
  beforeEach(() => {
    docs['families/fam2'] = { accountBalanceCents: 0 };
    docs[INVOICE2] = { ...OPEN, kinfolkId: 'fam2', kinfolkName: 'The Okafors', invoiceNumber: '1030' };
  });
  it('a link to another household\'s invoice is refused in plain words, with nothing recorded and nobody told', async () => {
    installOptimisticTransactions(ctx.db, docs);
    expect(await refusalOf(linked())).toEqual({
      status: 'failed-precondition',
      code: 'link_wrong_household',
      message: 'Invoice 1029 belongs to a different household than this payment.',
    });
    nothingRecordedOrSent();
  });
  it('the refusal never shows a stored id when the invoice has no number', async () => {
    installOptimisticTransactions(ctx.db, docs);
    docs[INVOICE] = { ...OPEN, invoiceNumber: '' };
    const refusal = await refusalOf(linked());
    expect(refusal).toMatchObject({ code: 'link_wrong_household' });
    expect(refusal!.message).toBe('That invoice belongs to a different household than this payment.');
    expect(ledgerRows()).toEqual([]);
  });
  it('the rule is held on the read the row is written from: an invoice that changes household mid-call is refused', async () => {
    // The invoice is this payment's household's when the call starts, so the
    // check ahead of the transaction passes. It changes hands before the
    // commit, the attempt runs again, and its own read refuses.
    docs[INVOICE] = { ...OPEN, kinfolkId: 'fam2' };
    let moved = false;
    const tx = installOptimisticTransactions(ctx.db, docs, {
      onRead: (path) => {
        if (path !== INVOICE || moved) return;
        moved = true;
        docs[INVOICE] = { ...docs[INVOICE]!, kinfolkId: 'fam1' };
      },
    });
    expect(await refusalOf(linked())).toEqual({
      status: 'failed-precondition',
      code: 'link_wrong_household',
      message: 'Invoice 1029 belongs to a different household than this payment.',
    });
    expect(moved).toBe(true);
    expect(tx.attempts()).toBe(2);
    expect(tx.committed()).toEqual([]);
    expect(ledgerRows()).toEqual([]);
    expect(hooks.enqueue).not.toHaveBeenCalled();
  });
  it('with account credit entered it is still the household refusal, and no credit is given', async () => {
    installOptimisticTransactions(ctx.db, docs);
    expect(await refusalOf(linked({ creditToAccountCents: 500 }))).toMatchObject({ code: 'link_wrong_household' });
    const settled = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
    hooks.enqueue.mockClear();
    hooks.billingUid.mockClear();
    const invoiceBefore = { ...docs[INVOICE]! };
    expect(
      await refusalOf(linked({ amount: 55, settledByInvoicePaymentId: settled.paymentId, creditToAccountCents: 1500 })),
    ).toMatchObject({ code: 'link_wrong_household' });
    expect(ledgerRows()).toEqual([]);
    expect(docs[INVOICE]).toEqual(invoiceBefore);
    expect(docs['families/fam2']!.accountBalanceCents).toBe(0);
    expect(hooks.enqueue).not.toHaveBeenCalled();
  });
  it('a payment applied to its own invoice cannot carry a link to another household\'s', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const refusal = await refusalOf(
      linked({ amount: 40, apply: { invoiceId: 'inv2', invoiceNumber: '1030', amount: 40 } }),
    );
    expect(refusal).toMatchObject({ status: 'failed-precondition', code: 'link_wrong_household' });
    expect(docs[INVOICE2]).toMatchObject({ status: 'open', amountDueCents: 4000 });
    expect(Object.keys(docs).filter((p) => p.startsWith(`${INVOICE2}/payments/`))).toEqual([]);
    nothingRecordedOrSent();
  });
  it('a link to the household\'s own invoice is recorded as before', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const res = await linked({ kinfolkId: 'fam1' });
    expect(res).toMatchObject({ paymentId: pay(1), kinfolkId: 'fam1' });
    expect(docs[`payments/${pay(1)}`]).toMatchObject({ kinfolkId: 'fam1', invoiceId: 'inv1', amountCents: 1000 });
    expect(hooks.enqueue).toHaveBeenCalled();
  });
  it('a payment applied to its own invoice and linked to it is recorded as before', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const res = await linked({
      amount: 40,
      invoiceId: 'inv2',
      invoiceNumber: '1030',
      apply: { invoiceId: 'inv2', invoiceNumber: '1030', amount: 40 },
    });
    expect(res).toMatchObject({ paymentId: pay(1), kinfolkId: 'fam2' });
    expect(docs[INVOICE2]).toMatchObject({ amountDueCents: 0 });
  });
  it('a payment with no household, an invoice with none, and a link to no stored invoice are not refused', async () => {
    installOptimisticTransactions(ctx.db, docs);
    await linked({ kinfolkId: '', sendConfirmationEmail: false });
    docs['invoices/inv3'] = { ...OPEN, kinfolkId: '', invoiceNumber: '1031' };
    await linked({ invoiceId: 'inv3', invoiceNumber: '1031', idempotencyKey: pay(2), sendConfirmationEmail: false });
    await linked({ invoiceId: 'inv_gone', invoiceNumber: '', idempotencyKey: pay(3), sendConfirmationEmail: false });
    expect(ledgerRows().sort()).toEqual([`payments/${pay(1)}`, `payments/${pay(2)}`, `payments/${pay(3)}`].sort());
  });
  it('a retry of a row stored before the rule is still answered from that row', async () => {
    installOptimisticTransactions(ctx.db, docs);
    const first = await linked({ kinfolkId: 'fam1', sendConfirmationEmail: false });
    // As an older build stored it: the row names the other household.
    docs[`payments/${pay(1)}`] = { ...docs[`payments/${pay(1)}`]!, kinfolkId: 'fam2' };
    const again = await linked({ sendConfirmationEmail: false });
    expect(again).toMatchObject({ paymentId: first.paymentId, kinfolkId: 'fam2' });
    expect(ledgerRows()).toEqual([`payments/${pay(1)}`]);
  });
});
