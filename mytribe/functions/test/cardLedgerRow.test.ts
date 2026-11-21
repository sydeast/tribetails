import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2276: A CARD PAYMENT IS ONE ROW ON THE INVOICE IT PAID.
 *
 * The Stripe webhook runs here for real against the same in-memory Firestore
 * and optimistic transactions as `paymentRace.test.ts`, next to the real
 * `markInvoicePaid`, `recordPayment`, repair pass and settlement sweep, so each
 * test reads what the other handlers actually do with the invoice the webhook
 * left behind. Only Stripe itself is stubbed: the event the signature check
 * hands back, and the fee lookup.
 */

const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  deliver: vi.fn(),
  log: vi.fn(),
  events: {} as Record<string, unknown>,
  feeCents: 146 as number | null,
  // #2334: the charge's `payment_method_details`, null for a charge that says nothing.
  methodDetails: null as unknown,
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => hooks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: hooks.log }));
vi.mock('../src/lib/writeAuditEntry', async () => ({
  ...(await vi.importActual<object>('../src/lib/writeAuditEntry')),
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({ resolveBillingRecipientUid: async () => 'kin-uid-1' }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: vi.fn().mockResolvedValue([]),
  enqueueNotificationDetailed: async (args: unknown) => hooks.enqueue(args),
  deliverListedCopy: async (args: unknown) => hooks.deliver(args),
}));
vi.mock('../src/lib/stripe', () => ({
  getStripe: async () => ({
    paymentIntents: {
      retrieve: async () => {
        if (hooks.feeCents === null) throw new Error('stripe unavailable');
        return {
          latest_charge: { balance_transaction: { fee: hooks.feeCents }, payment_method_details: hooks.methodDetails },
        };
      },
    },
    charges: { retrieve: vi.fn() },
  }),
  verifyStripeWebhook: (_body: Buffer, sig: string) => {
    const event = hooks.events[sig];
    if (!event) throw new Error('bad signature');
    return event;
  },
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      increment: (n: number) => ({ __increment: n }),
      delete: () => undefined,
      arrayUnion: (...values: unknown[]) => ({ __arrayUnion: values }),
    },
  };
});

import { stripeWebhookHandler } from '../src/billing/stripeWebhook';
import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { recordPaymentHandler } from '../src/admin/recordPayment';
import { repairInvoicePaymentsHandler } from '../src/admin/repairInvoicePayments';
import { applyAccountCreditHandler } from '../src/admin/applyAccountCredit';
import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { linkInvoiceSessionsHandler } from '../src/admin/linkInvoiceSessions';
import { invoiceStateStampOf } from '../src/lib/invoiceStateStamp';
import { paymentStandingOfInvoice } from '../src/lib/invoicePaidGate';
import { sweepAbandonedSettlements, settlementLedgerRowId } from '../src/lib/settlementLedgerSweep';
import {
  PAYMENT_APPLIED_OWNER_FIELD,
  SETTLEMENT_LEDGER_PENDING_FIELD,
  SETTLEMENT_LEDGER_SWEEP_GRACE_MS,
} from '../src/lib/paymentAppliedOwner';
import {
  CARD_APPLY_FALLBACK_FIELD,
  STATED_BELOW_RECORDED,
  cardPaymentRowId,
  decideCardApply,
  fallbackNeedsOwnerLine,
} from '../src/lib/cardPaymentApply';

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
const META = { familyId: 'fam1', kinfolkId: 'fam1', invoiceId: 'inv1', uid: 'kin-uid-1', checkoutRound: '0' };

/** The two events one card payment delivers: the Checkout Session, then its PaymentIntent. */
function cardPayment(n: number, cents: number, meta: Record<string, string> = META) {
  hooks.events[`session-${n}`] = {
    id: `evt_cs_${n}`,
    type: 'checkout.session.completed',
    created: 1_763_000_000 + n,
    data: {
      object: { id: `cs_${n}`, payment_intent: `pi_${n}`, payment_status: 'paid', amount_total: cents, metadata: meta },
    },
  };
  hooks.events[`intent-${n}`] = {
    id: `evt_pi_${n}`,
    type: 'payment_intent.succeeded',
    created: 1_763_000_000 + n,
    data: { object: { id: `pi_${n}`, amount_received: cents, metadata: meta } },
  };
}

/** Delivers one event to the real handler and answers with the HTTP status. */
async function deliver(sig: string): Promise<number> {
  let code = 0;
  const res = {
    status: (c: number) => {
      code = c;
      return res;
    },
    json: () => res,
    end: () => res,
  };
  await (stripeWebhookHandler as any)(
    { method: 'POST', headers: { 'stripe-signature': sig }, rawBody: Buffer.from('{}') },
    res,
  );
  return code;
}

beforeEach(() => {
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.deliver.mockReset();
  hooks.deliver.mockResolvedValue({ outcome: 'sent', channels: ['email'] });
  hooks.log.mockReset();
  hooks.feeCents = 146;
  hooks.methodDetails = null;
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
  docs = { [INVOICE]: { ...OPEN }, 'families/fam1': { accountBalanceCents: 12000 } };
  ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
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

const invoiceRows = () =>
  Object.entries(docs).filter(([p, d]) => p.startsWith(`${INVOICE}/payments/`) && d != null) as Array<
    [string, Record<string, any>]
  >;
const invoiceRowsCents = () => invoiceRows().reduce((sum, [, d]) => sum + (d.amountCents as number), 0);
const cardRows = () => invoiceRows().filter(([, d]) => d.method === 'stripe');
const ledgerRows = () =>
  Object.entries(docs).filter(([p, d]) => /^payments\/[^/]+$/.test(p) && d != null) as Array<
    [string, Record<string, any>]
  >;
const cardLedgerRows = () => ledgerRows().filter(([, d]) => d.paymentMethod === 'stripe');
const paidNotices = () => hooks.enqueue.mock.calls.filter((c) => c[0]?.key === 'invoice.payment.applied');

/** The invoice agrees with its own payment rows: paid is their sum, due is the total less it. */
function expectBalanceMatchesPayments() {
  const inv = docs[INVOICE]!;
  const paid = invoiceRowsCents();
  expect(inv.paidCents).toBe(paid);
  expect(inv.amountDueCents).toBe(Math.max(0, inv.totalCents - paid));
}

const recordApply = (cents: number, n = 9) =>
  recordPaymentHandler(
    req({
      kinfolkId: 'fam1',
      kinfolkName: 'The Riveras',
      client: 'Ana Rivera',
      date: '2026-11-14',
      paymentMethod: 'venmo',
      referenceNumber: 'VN-9',
      amount: cents / 100,
      invoiceId: 'inv1',
      invoiceNumber: '1029',
      apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: cents / 100 },
      idempotencyKey: pay(n),
    }),
  );

describe('#2276: a part payment recorded by hand, then the rest paid by card', () => {
  it('the card payment is a row on the invoice, and the rows add up to the total', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, method: 'cash', idempotencyKey: ipay(1) }));
    cardPayment(1, 2500);

    expect(await deliver('session-1')).toBe(200);

    expect(docs[`${INVOICE}/payments/${cardPaymentRowId('pi_1', 'evt_cs_1')}`]).toMatchObject({
      amount: 25,
      amountCents: 2500,
      method: 'stripe',
      reference: 'pi_1',
      sourcePaymentId: 'evt_cs_1',
      stripePaymentIntentId: 'pi_1',
    });
    expect(invoiceRows()).toHaveLength(2);
    expect(invoiceRowsCents()).toBe(4000);
    expect(docs[INVOICE]).toMatchObject({
      status: 'paid',
      paymentStatus: 'PAID',
      totalCents: 4000,
      paidCents: 4000,
      amountDueCents: 0,
      amountDue: 0,
      overpaidCents: 0,
      // Frozen, like any invoice its payments cover. Before #2276 this read
      // 'all': paid, with rows short of the total.
      editScope: 'none',
      stripeCheckoutRound: 1,
      stripeSettledPaymentIntentId: 'pi_1',
      [PAYMENT_APPLIED_OWNER_FIELD]: 'stripe:evt_cs_1',
    });
    expectBalanceMatchesPayments();
    // The ledger row says which invoice it paid, like a recorded payment's.
    expect(docs['payments/evt_cs_1']).toMatchObject({
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      amountCents: 2500,
      paymentMethod: 'stripe',
      appliedInvoiceId: 'inv1',
      appliedInvoiceNumber: '1029',
      appliedCents: 2500,
      tipCents: 0,
      unappliedCents: 0,
      feeCents: 146,
      proceedsCents: 2354,
      settlesInvoice: true,
    });
    expect(docs['payments/evt_cs_1']![CARD_APPLY_FALLBACK_FIELD]).toBeUndefined();
    expect(paidNotices()).toHaveLength(1);
    // No account credit was given or spent.
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
  });

  it('nothing accepts the card-paid part a second time', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(1) }));
    cardPayment(1, 2500);
    await deliver('session-1');

    // The one-call Record payment, for exactly the part the card paid.
    await expect(recordApply(2500)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_already_settled' },
    });
    // An older admin build's first call, with an amount and with none.
    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 25, idempotencyKey: ipay(2) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_already_settled' } });
    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', idempotencyKey: ipay(3) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_already_settled' } });

    expect(invoiceRows()).toHaveLength(2);
    expect(docs[`payments/${pay(9)}`]).toBeUndefined();
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
  });

  it('the repair pass, in repair mode, leaves it paid', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(1) }));
    cardPayment(1, 2500);
    await deliver('session-1');

    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));

    expect(res.repaired).toBe(0);
    expect(res.skipped.payments_cover_total).toBe(1);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
  });

  it('the same holds when the part payment was the one-call Record payment', async () => {
    await recordApply(1500, 1);
    cardPayment(1, 2500);

    expect(await deliver('intent-1')).toBe(200);

    expect(invoiceRowsCents()).toBe(4000);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paymentStatus: 'PAID', paidCents: 4000, amountDueCents: 0 });
    expectBalanceMatchesPayments();
    await expect(recordApply(2500)).rejects.toMatchObject({ details: { code: 'invoice_already_settled' } });
  });
});

describe('#2276: an invoice paid by card alone', () => {
  it('gets its one row, and is settled by its payments, not only by its label', async () => {
    cardPayment(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    expect(cardRows()).toHaveLength(1);
    expect(invoiceRowsCents()).toBe(4000);
    expect(docs[INVOICE]).toMatchObject({
      status: 'paid',
      paymentStatus: 'PAID',
      paidCents: 4000,
      amountDueCents: 0,
      editScope: 'none',
      paymentMethod: 'stripe',
      paymentReference: 'pi_1',
    });
    expectBalanceMatchesPayments();
    expect(docs['payments/evt_cs_1']).toMatchObject({ appliedInvoiceId: 'inv1', appliedCents: 4000, tipCents: 0 });
    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_already_settled' } });
  });

  it('a fee Stripe did not return leaves the fee and the proceeds unsaid, never zero', async () => {
    hooks.feeCents = null;
    cardPayment(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    const row = docs['payments/evt_cs_1']!;
    expect(row).toMatchObject({ feeResolved: false, appliedCents: 4000 });
    expect('feeCents' in row).toBe(false);
    expect('proceedsCents' in row).toBe(false);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000 });
  });
});

describe('#2276: one card payment is one row, however often Stripe tells us', () => {
  it('both events and a retry of each: one invoice row, one ledger row, one notice', async () => {
    cardPayment(1, 4000);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(cardRows()).toHaveLength(1);
    expect(cardLedgerRows().map(([p]) => p)).toEqual(['payments/evt_cs_1']);
    expect(docs['stripeEvents/evt_pi_1']).toMatchObject({ appliedOutcome: 'SKIPPED_DUPLICATE_PAYMENT' });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0, stripeCheckoutRound: 1 });
    expectBalanceMatchesPayments();
    expect(paidNotices()).toHaveLength(1);
  });

  it('the PaymentIntent event first gives the same single row', async () => {
    cardPayment(1, 4000);

    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expect(cardRows().map(([p]) => p)).toEqual([`${INVOICE}/payments/stripe_pi_1`]);
    expect(cardLedgerRows().map(([p]) => p)).toEqual(['payments/evt_pi_1']);
    expectBalanceMatchesPayments();
  });

  it('the second event landing while the first is still deciding: still one row', async () => {
    cardPayment(1, 4000);
    let fired = false;
    let inner = 0;
    const tx = installOptimisticTransactions(ctx.db, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        inner = await deliver('intent-1');
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(fired).toBe(true);
    expect(inner).toBe(200);
    // The first event re-ran against what the second committed.
    expect(tx.attempts()).toBeGreaterThanOrEqual(3);
    expect(cardRows()).toHaveLength(1);
    expect(cardLedgerRows()).toHaveLength(1);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0, stripeCheckoutRound: 1 });
    expectBalanceMatchesPayments();
    expect(paidNotices()).toHaveLength(1);
  });

  it('a notice that fails answers 500, and the retry sends it without a second row', async () => {
    cardPayment(1, 4000);
    hooks.enqueue.mockRejectedValueOnce(new Error('queue down'));

    expect(await deliver('session-1')).toBe(500);
    expect(cardRows()).toHaveLength(1);
    expect(await deliver('session-1')).toBe(200);

    expect(cardRows()).toHaveLength(1);
    expect(cardLedgerRows()).toHaveLength(1);
    expect(docs[INVOICE]).toMatchObject({ paidCents: 4000, amountDueCents: 0 });
    expect(hooks.enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('#2276: a card payment racing a payment recorded by hand', () => {
  it('a part payment recorded while the card payment is deciding: the card pays what is left, the rest is tip', async () => {
    cardPayment(1, 4000);
    let fired = false;
    installOptimisticTransactions(ctx.db, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(1) }));
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(fired).toBe(true);
    expect(docs[`${INVOICE}/payments/stripe_pi_1`]).toMatchObject({ amountCents: 2500 });
    expect(docs['payments/evt_cs_1']).toMatchObject({ amountCents: 4000, appliedCents: 2500, tipCents: 1500 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0, overpaidCents: 0 });
    expectBalanceMatchesPayments();
  });

  it('a payoff recorded while the card payment is deciding: the card payment is held for the owner, not applied', async () => {
    cardPayment(1, 4000);
    let fired = false;
    installOptimisticTransactions(ctx.db, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) }));
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(cardRows()).toHaveLength(0);
    expect(invoiceRowsCents()).toBe(4000);
    expect(docs['payments/evt_cs_1']).toMatchObject({ appliedToInvoice: false, needsAdminDecision: true });
    expect(docs['payments/evt_cs_1']!.appliedInvoiceId).toBeUndefined();
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
  });

  it('the card payment landing while a payoff is being recorded by hand: the hand payment is refused', async () => {
    cardPayment(1, 4000);
    let fired = false;
    installOptimisticTransactions(ctx.db, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        await deliver('session-1');
      },
    });

    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: ipay(1) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_already_settled' } });

    expect(invoiceRows().map(([p]) => p)).toEqual([`${INVOICE}/payments/stripe_pi_1`]);
    expectBalanceMatchesPayments();
  });
});

describe('#2276: a card payment over the balance', () => {
  it('pays the balance, and the rest is the gross tip with the fee beside it', async () => {
    // The checkout was opened for the whole $40.00; $15.00 was then recorded
    // by hand; the household paid the $40.00 page.
    cardPayment(1, 4000);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 15, idempotencyKey: ipay(1) }));

    expect(await deliver('session-1')).toBe(200);

    expect(docs[`${INVOICE}/payments/stripe_pi_1`]).toMatchObject({ amount: 25, amountCents: 2500 });
    expect(docs[INVOICE]).toMatchObject({
      status: 'paid',
      paymentStatus: 'PAID',
      paidCents: 4000,
      amountDueCents: 0,
      // The invoice is paid exactly. The extra is on the payment, as tip.
      overpaidCents: 0,
    });
    expectBalanceMatchesPayments();
    expect(docs['payments/evt_cs_1']).toMatchObject({
      amountCents: 4000,
      appliedCents: 2500,
      tipCents: 1500,
      tipBasis: 'gross',
      feeCents: 146,
      unappliedCents: 0,
      proceedsCents: 3854,
      creditedToAccountCents: 0,
    });
    // Never account credit.
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
    expect(Object.keys(docs).some((p) => p.startsWith('families/fam1/'))).toBe(false);
  });
});

describe('#2276: a card payment under the balance', () => {
  it('leaves the rest owing when the invoice grew after the checkout was opened', async () => {
    cardPayment(1, 4000);
    // A line was added: the invoice now says $60.00, all of it owed.
    docs[INVOICE] = { ...docs[INVOICE], total: 60, totalCents: 6000, amountDue: 60, amountDueCents: 6000 };

    expect(await deliver('session-1')).toBe(200);

    expect(docs[`${INVOICE}/payments/stripe_pi_1`]).toMatchObject({ amountCents: 4000 });
    expect(docs[INVOICE]).toMatchObject({
      status: 'open',
      paymentStatus: 'PARTIAL',
      paidCents: 4000,
      amountDueCents: 2000,
      amountDue: 20,
      // Checkouts opened for the old balance are now stale.
      stripeCheckoutRound: 1,
    });
    expectBalanceMatchesPayments();
    expect(docs['payments/evt_cs_1']).toMatchObject({ appliedCents: 4000, tipCents: 0, settlesInvoice: false });
  });
});

describe('#2276: the settlement sweep and a card payment, in either order', () => {
  const later = () => Date.now() + SETTLEMENT_LEDGER_SWEEP_GRACE_MS + 1000;
  const settleRow = `payments/${settlementLedgerRowId(ipay(1))}`;

  /** An older admin build paid the invoice off and stopped; the invoice then grew by $20.00. */
  async function paidOffByOldBuildThenGrown() {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, method: 'cash', idempotencyKey: ipay(1) }));
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe(`markInvoicePaid:${ipay(1)}`);
    docs[INVOICE] = {
      ...docs[INVOICE],
      status: 'open',
      paymentStatus: 'PARTIAL',
      total: 60,
      totalCents: 6000,
      amountDue: 20,
      amountDueCents: 2000,
    };
    cardPayment(1, 2000);
  }

  function expectBothRecordedOnce() {
    expect(docs[settleRow]).toMatchObject({ amountCents: 4000, settledByInvoicePaymentId: ipay(1) });
    expect(cardRows()).toHaveLength(1);
    expect(cardLedgerRows()).toHaveLength(1);
    expect(ledgerRows()).toHaveLength(2);
    expect(invoiceRows()).toHaveLength(2);
    expect(docs[INVOICE]).toMatchObject({
      status: 'paid',
      paymentStatus: 'PAID',
      paidCents: 6000,
      amountDueCents: 0,
      [SETTLEMENT_LEDGER_PENDING_FIELD]: '',
    });
    expectBalanceMatchesPayments();
  }

  it('the card payment first, then the sweep', async () => {
    await paidOffByOldBuildThenGrown();

    expect(await deliver('session-1')).toBe(200);
    // The card payment did not take the hand settlement's pending stamp.
    expect(docs[INVOICE]![SETTLEMENT_LEDGER_PENDING_FIELD]).toBe(`markInvoicePaid:${ipay(1)}`);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);

    expectBothRecordedOnce();
  });

  it('the sweep first, then the card payment', async () => {
    await paidOffByOldBuildThenGrown();

    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(await deliver('session-1')).toBe(200);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(0);

    expectBothRecordedOnce();
  });

  it('the sweep landing while the card payment is deciding', async () => {
    await paidOffByOldBuildThenGrown();
    let fired = false;
    installOptimisticTransactions(ctx.db, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        await sweepAbandonedSettlements(ctx.db as never, later());
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(fired).toBe(true);
    expectBothRecordedOnce();
  });

  it('a card charge on an invoice the old build already paid off is held, before or after the sweep', async () => {
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, method: 'cash', idempotencyKey: ipay(1) }));
    cardPayment(1, 4000);
    cardPayment(2, 4000);

    expect(await deliver('session-1')).toBe(200);
    expect(await sweepAbandonedSettlements(ctx.db as never, later())).toBe(1);
    expect(await deliver('session-2')).toBe(200);

    expect(cardRows()).toHaveLength(0);
    expect(invoiceRowsCents()).toBe(4000);
    expect(docs['payments/evt_cs_1']).toMatchObject({ needsAdminDecision: true, appliedToInvoice: false });
    expect(docs['payments/evt_cs_2']).toMatchObject({ needsAdminDecision: true, appliedToInvoice: false });
    expect(docs[settleRow]).toMatchObject({ amountCents: 4000 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
  });
});

describe('#2276: invoices the ordinary plan cannot describe are paid and flagged, or held (#2345)', () => {
  const fallbackWarnings = () => hooks.log.mock.calls.filter((c) => c[0]?.event === 'stripe.cardApply.fallback');

  it('a stated balance lower than the payment rows leave: paid as shown, never reopened', async () => {
    // An earlier card payment from before #2276 paid $137.50 and left no row.
    // A line was added and the household was shown, and paid, $50.00.
    docs[INVOICE] = {
      ...OPEN,
      total: 187.5,
      totalCents: 18750,
      amountDue: 50,
      amountDueCents: 5000,
      stripeCheckoutRound: 1,
      stripeSettledPaymentIntentId: 'pi_0',
    };
    cardPayment(1, 5000, { ...META, checkoutRound: '1' });

    expect(await deliver('session-1')).toBe(200);

    expect(docs[INVOICE]).toMatchObject({
      status: 'paid',
      paymentStatus: 'PAID',
      amountDue: 0,
      amountDueCents: 0,
      paidCents: 5000,
      stripeCheckoutRound: 2,
      stripeSettledPaymentIntentId: 'pi_1',
      [CARD_APPLY_FALLBACK_FIELD]: STATED_BELOW_RECORDED,
    });
    expect(docs[`${INVOICE}/payments/stripe_pi_1`]).toMatchObject({ amountCents: 5000, method: 'stripe' });
    expect(docs['payments/evt_cs_1']).toMatchObject({
      appliedInvoiceId: 'inv1',
      appliedCents: 5000,
      tipCents: 0,
      [CARD_APPLY_FALLBACK_FIELD]: STATED_BELOW_RECORDED,
    });
    expect(fallbackWarnings()).toHaveLength(1);
    expect(fallbackWarnings()[0]![0]).toMatchObject({ severity: 'warn', extra: { reason: STATED_BELOW_RECORDED } });
    // The sibling event changes nothing.
    expect(await deliver('intent-1')).toBe(200);
    expect(cardRows()).toHaveLength(1);
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it('and that invoice, paid with rows short of its total, is not collectable again, reopened or editable', async () => {
    // Before #2276 it had no rows at all and its paid label was believed. The
    // one row it has now must not make it read part paid to anything.
    docs[INVOICE] = {
      ...OPEN,
      total: 187.5,
      totalCents: 18750,
      amountDue: 50,
      amountDueCents: 5000,
      stripeCheckoutRound: 1,
      stripeSettledPaymentIntentId: 'pi_0',
    };
    cardPayment(1, 5000, { ...META, checkoutRound: '1' });
    await deliver('session-1');
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', editScope: 'none', paidCents: 5000 });

    await expect(recordApply(13750)).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'invoice_already_paid' },
    });
    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 137.5, idempotencyKey: ipay(2) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_already_paid' } });
    await expect(
      markInvoicePaidHandler(req({ invoiceId: 'inv1', idempotencyKey: ipay(3) })),
    ).rejects.toMatchObject({ details: { code: 'invoice_already_paid' } });
    const credit = await applyAccountCreditHandler(req({ invoiceId: 'inv1', amountCents: 1000, idempotencyKey: 'acr_1790000000000_fallbk' })).catch(
      (err) => ({ threw: err }),
    );
    expect(docs['families/fam1']!.accountBalanceCents).toBe(12000);
    expect(credit).not.toMatchObject({ applied: true });

    const res = await repairInvoicePaymentsHandler(req({ mode: 'repair' }));
    expect(res.repaired).toBe(0);

    expect(invoiceRows()).toHaveLength(1);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0, paidCents: 5000 });
  });

  it('and an edit of that invoice is refused by the server, so its balance cannot come back', async () => {
    // The stored stamp is what the screens read. The edit itself decides from
    // the payment rows, and those fall short of the total here: before the
    // review fix a change of terms alone brought back $137.50 owed.
    docs[INVOICE] = {
      ...OPEN,
      total: 187.5,
      totalCents: 18750,
      amountDue: 50,
      amountDueCents: 5000,
      lineItems: [{ description: 'Overnight stay', qty: 1, unitCents: 18750 }],
      sessionIds: [],
      stripeCheckoutRound: 1,
      stripeSettledPaymentIntentId: 'pi_0',
    };
    cardPayment(1, 5000, { ...META, checkoutRound: '1' });
    await deliver('session-1');
    const paid = { status: 'paid', paymentStatus: 'PAID', amountDue: 0, amountDueCents: 0, editScope: 'none' };
    expect(docs[INVOICE]).toMatchObject(paid);

    await expect(
      updateInvoiceHandler(req({ invoiceId: 'inv1', patch: { terms: 'Due on receipt' } })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_not_editable' } });
    await expect(
      updateInvoiceHandler(
        req({
          invoiceId: 'inv1',
          patch: {
            lineItems: [
              { description: 'Overnight stay', qty: 1, unitCents: 18750 },
              { description: 'Extra walk', qty: 1, unitCents: 1000 },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_not_editable' } });
    expect(docs[INVOICE]).toMatchObject({ ...paid, total: 187.5, totalCents: 18750, paidCents: 5000 });

    // Linking visits re-stamps the invoice. It stays locked.
    await linkInvoiceSessionsHandler(req({ invoiceId: 'inv1', sessionIds: [] }));
    expect(docs[INVOICE]).toMatchObject(paid);
  });

  it('the stamp of an invoice paid by the fallback is locked from its label, whatever its rows add up to', () => {
    const doc = { status: 'paid', paymentStatus: 'PAID', total: 187.5, totalCents: 18750, amountDue: 0, amountDueCents: 0 };
    // Rows short of the total with no fallback stamp: the part-paid repair path stays open.
    expect(invoiceStateStampOf(doc, 5000)).toEqual({ status: 'paid', editScope: 'all' });
    const fallback = { ...doc, [CARD_APPLY_FALLBACK_FIELD]: STATED_BELOW_RECORDED };
    expect(invoiceStateStampOf(fallback, 5000)).toEqual({ status: 'paid', editScope: 'none' });
    expect(paymentStandingOfInvoice(fallback, 5000)).toBe('settled');
    expect(paymentStandingOfInvoice(doc, 5000)).toBe('partial');
    expect(paymentStandingOfInvoice(doc, 0)).toBe('none');
    // The stamp alone, on an invoice that is open again, locks nothing.
    expect(
      paymentStandingOfInvoice({ ...doc, status: 'open', paymentStatus: 'PARTIAL', [CARD_APPLY_FALLBACK_FIELD]: 'x' }, 5000),
    ).toBe('partial');
  });

  it('an invoice with a balance and no total: held for the owner, not applied (#2345)', async () => {
    docs[INVOICE] = { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'open', amountDue: 10 };
    cardPayment(1, 1000);

    expect(await deliver('session-1')).toBe(200);

    expect(docs[INVOICE]).toMatchObject({ status: 'open', amountDue: 10 });
    expect(docs[INVOICE]!.paidCents).toBeUndefined();
    expect(docs[INVOICE]![CARD_APPLY_FALLBACK_FIELD]).toBeUndefined();
    expect(invoiceRows()).toHaveLength(0);
    expect(docs['payments/evt_cs_1']).toMatchObject({
      amountCents: 1000,
      appliedTo: 'unapplied',
      needsAdminDecision: true,
      duplicateCheckoutReason: 'invoice-no-balance',
    });
    expect(cardLedgerRows()).toHaveLength(1);
    expect(paidNotices()).toHaveLength(0);
  });

  it('no amount from Stripe or the invoice: paid and flagged, with no invoice row invented', async () => {
    // Owed on its total, which is kept in cents only: the dollar fields the
    // charge would be read from are not there.
    docs[INVOICE] = { kinfolkId: 'fam1', status: 'open', totalCents: 4000 };
    hooks.events['bare'] = {
      id: 'evt_bare',
      type: 'payment_intent.succeeded',
      created: 1_763_000_000,
      data: { object: { id: 'pi_bare', metadata: META } },
    };

    expect(await deliver('bare')).toBe(200);

    expect(invoiceRows()).toHaveLength(0);
    expect(docs['payments/evt_bare']).toMatchObject({ amountResolved: false, amountCents: null });
    expect(docs['payments/evt_bare']!.appliedInvoiceId).toBeUndefined();
    expect(docs['payments/evt_bare']!.needsAdminDecision).toBeUndefined();
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0 });
  });

  it('no amount from Stripe, and an invoice with no total: held for the owner, not marked paid (#2345)', async () => {
    const before = { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'open' };
    docs[INVOICE] = { ...before };
    hooks.events['bare'] = {
      id: 'evt_bare',
      type: 'payment_intent.succeeded',
      created: 1_763_000_000,
      data: { object: { id: 'pi_bare', metadata: META } },
    };

    expect(await deliver('bare')).toBe(200);

    expect(invoiceRows()).toHaveLength(0);
    expect(docs['payments/evt_bare']).toMatchObject({
      amountResolved: false,
      amountCents: null,
      appliedTo: 'unapplied',
      needsAdminDecision: true,
      duplicateCheckoutReason: 'invoice-no-balance',
    });
    expect(docs[INVOICE]).toMatchObject(before);
    expect(docs[INVOICE]!.paidAt).toBeUndefined();
    expect(docs[INVOICE]!.amountDueCents).toBeUndefined();
    expect(paidNotices()).toHaveLength(0);
  });

  it('a household on the checkout that is not the invoice\'s: held for that household, and the invoice is untouched (#2345)', async () => {
    const before = { ...docs[INVOICE] };
    cardPayment(1, 4000, { ...META, familyId: 'fam2', kinfolkId: 'fam2' });

    expect(await deliver('session-1')).toBe(200);

    expect(docs[INVOICE]).toEqual(before);
    expect(cardRows()).toHaveLength(0);
    expect(docs['payments/evt_cs_1']).toMatchObject({
      kinfolkId: 'fam2',
      appliedTo: 'unapplied',
      duplicateCheckoutReason: 'invoice-other-household',
    });
    expect(paidNotices()).toHaveLength(0);
  });
});

describe('#2276: where a card payment lands (decideCardApply)', () => {
  const doc = { kinfolkId: 'fam1', status: 'open', total: 40, totalCents: 4000, amountDue: 40, amountDueCents: 4000 };
  const decide = (over: Partial<Parameters<typeof decideCardApply>[0]> = {}) =>
    decideCardApply({ invoiceId: 'inv1', doc, existingPayments: [], cardCents: 4000, kinfolkId: 'fam1', ...over });

  it('pays the invoice off exactly', () => {
    const d = decide();
    expect(d).toMatchObject({ kind: 'planned', appliedCents: 4000, tipCents: 0 });
    expect(d.kind === 'planned' && d.step.after).toMatchObject({ state: 'settled', paidCents: 4000, amountDueCents: 0 });
  });

  it('applies only what the rows leave owing; the rest is tip', () => {
    const d = decide({ existingPayments: [{ amountCents: 1500 }], doc: { ...doc, amountDue: 25, amountDueCents: 2500 } });
    expect(d).toMatchObject({ kind: 'planned', appliedCents: 2500, tipCents: 1500 });
  });

  it('a card payment under both balances leaves the rest owing', () => {
    const d = decide({ cardCents: 1000 });
    expect(d).toMatchObject({ kind: 'planned', appliedCents: 1000, tipCents: 0 });
    expect(d.kind === 'planned' && d.step.after).toMatchObject({ state: 'partial', amountDueCents: 3000 });
  });

  it('a card payment covering the stated balance never reopens the invoice', () => {
    const d = decide({ cardCents: 1000, doc: { ...doc, amountDue: 10, amountDueCents: 1000 } });
    expect(d).toEqual({
      kind: 'fallback',
      reason: STATED_BELOW_RECORDED,
      writeRow: true,
      appliedCents: 1000,
      tipCents: 0,
      paidCents: 1000,
      leftOwingCents: 0,
    });
  });
  it('#2345: a fallback card short of the stated balance leaves the rest owing', () => {
    // A balance and no total: the plan cannot describe it.
    const noTotal = { kinfolkId: 'fam1', status: 'open', amountDue: 100, amountDueCents: 10000 };
    expect(decide({ doc: noTotal, cardCents: 6000 })).toEqual({
      kind: 'fallback',
      reason: 'no_recorded_balance',
      writeRow: true,
      appliedCents: 6000,
      tipCents: 0,
      paidCents: 6000,
      leftOwingCents: 4000,
    });
    // Covering it, or over it: nothing left, the rest is tip.
    expect(decide({ doc: noTotal, cardCents: 10000 })).toMatchObject({ leftOwingCents: 0, tipCents: 0 });
    expect(decide({ doc: noTotal, cardCents: 12000 })).toMatchObject({ leftOwingCents: 0, tipCents: 2000 });
    // No stated balance at all: the whole card goes on the bill, nothing left.
    expect(decide({ doc: { kinfolkId: 'fam1', status: 'open' }, cardCents: 6000 })).toMatchObject({
      reason: 'no_recorded_balance',
      leftOwingCents: 0,
    });
  });
  it('#2345: every fallback reason but the stated-below-recorded one gets the owner a line', () => {
    for (const reason of ['no_recorded_balance', 'apply_invoice_not_sent', 'apply_wrong_household', 'apply_invoice_not_payable', 'apply_invoice_not_found']) {
      expect(fallbackNeedsOwnerLine(reason), reason).toBe(true);
    }
    expect(fallbackNeedsOwnerLine(STATED_BELOW_RECORDED)).toBe(false);
    expect(fallbackNeedsOwnerLine(null)).toBe(false);
    expect(fallbackNeedsOwnerLine('')).toBe(false);
  });

  it('a cancelled invoice, a draft and a credit fall back with the plan\'s own reason', () => {
    expect(decide({ doc: { ...doc, status: 'cancelled' } })).toMatchObject({ kind: 'fallback', reason: 'apply_invoice_not_payable' });
    expect(decide({ doc: { ...doc, status: 'draft' } })).toMatchObject({ kind: 'fallback', reason: 'apply_invoice_not_sent' });
  });

  it('no invoice document: nothing to hang a row on', () => {
    expect(decide({ doc: null })).toMatchObject({ kind: 'fallback', reason: 'apply_invoice_not_found', writeRow: false });
  });

  it('no amount: no row', () => {
    expect(decide({ cardCents: null })).toEqual({ kind: 'no-amount' });
    expect(decide({ cardCents: 0 })).toEqual({ kind: 'no-amount' });
  });

  it('names the row after the PaymentIntent, and after the event only when there is none', () => {
    expect(cardPaymentRowId('pi_1', 'evt_1')).toBe('stripe_pi_1');
    expect(cardPaymentRowId(null, 'evt_1')).toBe('stripe_evt_1');
  });
});

describe('#2334: the card payment rows carry what it was actually paid with', () => {
  it('a Klarna payment: the invoice row and the ledger row both say klarna, beside the stored stripe', async () => {
    hooks.methodDetails = { type: 'klarna', klarna: {} };
    cardPayment(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    const [[, row]] = cardRows();
    expect(row).toMatchObject({ method: 'stripe', onlineMethod: 'klarna' });
    expect(docs['payments/evt_cs_1']).toMatchObject({ paymentMethod: 'stripe', onlineMethod: 'klarna' });
  });

  it('a card from Apple Pay is stored as the wallet', async () => {
    hooks.methodDetails = { type: 'card', card: { wallet: { type: 'apple_pay' } } };
    cardPayment(1, 4000);

    expect(await deliver('intent-1')).toBe(200);

    const [[, row]] = cardRows();
    expect(row.onlineMethod).toBe('apple_pay');
    expect(docs['payments/evt_pi_1']).toMatchObject({ onlineMethod: 'apple_pay' });
  });

  it('a Stripe lookup that fails stores no method at all, never a guess, and the payment still lands', async () => {
    hooks.feeCents = null;
    hooks.methodDetails = { type: 'card' };
    cardPayment(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    const [[, row]] = cardRows();
    expect('onlineMethod' in row).toBe(false);
    expect('onlineMethod' in docs['payments/evt_cs_1']!).toBe(false);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000 });
  });

  it('a charge that does not say leaves the field off', async () => {
    cardPayment(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    const [[, row]] = cardRows();
    expect('onlineMethod' in row).toBe(false);
  });

  it('a duplicate charge held for the owner carries its method on the held row', async () => {
    hooks.methodDetails = { type: 'affirm', affirm: {} };
    cardPayment(1, 4000);
    expect(await deliver('session-1')).toBe(200);
    // A second checkout on the now-paid bill: held, not applied.
    cardPayment(2, 4000);

    expect(await deliver('session-2')).toBe(200);

    expect(docs['payments/evt_cs_2']).toMatchObject({ needsAdminDecision: true, onlineMethod: 'affirm' });
  });
});
