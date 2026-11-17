import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * CARD PAYMENTS AND DECLINES ON AN INVOICE THAT CANNOT BE PAID.
 *
 *   #2361  a declined card on a cancelled (or written-off) invoice tells the
 *          household nothing and leaves the owner one Activity Log line.
 *   #2363  a payment held on a written-off invoice says written off, not paid.
 *   #2370  a held payment whose fee lookup fails warns like an applied one.
 *   #2345  a card payment on an invoice that was not in a state to be paid
 *          gets the owner a line, and a short one leaves the rest owing.
 *
 * The webhook runs for real against one in-memory Firestore with optimistic
 * transactions, the harness of `cancelledInvoiceCardPayment.test.ts`. Only
 * Stripe is stubbed.
 */

const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
  events: {} as Record<string, unknown>,
  feeCents: 146 as number | null,
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => hooks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: hooks.log }));
vi.mock('../src/lib/writeAuditEntry', async () => ({
  ...(await vi.importActual<object>('../src/lib/writeAuditEntry')),
  writeAuditEntry: hooks.audit,
}));
vi.mock('../src/lib/resolveBillingRecipientUid', () => ({ resolveBillingRecipientUid: async () => 'kin-uid-1' }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: vi.fn().mockResolvedValue([]),
  enqueueNotificationDetailed: async (args: unknown) => hooks.enqueue(args),
}));
vi.mock('../src/lib/stripe', () => ({
  getStripe: async () => ({
    paymentIntents: {
      retrieve: async () => {
        if (hooks.feeCents === null) throw new Error('stripe unavailable');
        return { latest_charge: { balance_transaction: { fee: hooks.feeCents } } };
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

import { stripeWebhookHandler, notPayableDetailOf } from '../src/billing/stripeWebhook';
import { cardDeclinedAfterPaymentWords, cardPaymentNotPayableWords } from '../src/lib/activityWords';

type Docs = Record<string, Record<string, any> | null>;
let docs: Docs;

const INVOICE = 'invoices/inv1';
const OPEN = {
  kinfolkId: 'fam1',
  kinfolkName: 'The Riveras',
  status: 'open',
  invoiceNumber: '1029',
  total: 40,
  totalCents: 4000,
  amountDue: 40,
  amountDueCents: 4000,
};
const CANCELLED = { ...OPEN, status: 'cancelled', invoiceStatus: 'cancelled' };
/** What `writeOffInvoice` leaves: the status, a zero balance and the time. */
const WRITTEN_OFF = { ...OPEN, status: 'written_off', amountDue: 0, amountDueCents: 0, writtenOffAt: 'ts', writtenOffCents: 4000 };
const META = { familyId: 'fam1', kinfolkId: 'fam1', invoiceId: 'inv1', uid: 'kin-uid-1', checkoutRound: '0' };
const T0 = 1_763_000_000;

function paid(n: number, cents: number, meta: Record<string, string> = META) {
  hooks.events[`session-${n}`] = {
    id: `evt_cs_${n}`,
    type: 'checkout.session.completed',
    created: T0 + n,
    data: { object: { id: `cs_${n}`, payment_intent: `pi_${n}`, payment_status: 'paid', amount_total: cents, metadata: meta } },
  };
  hooks.events[`intent-${n}`] = {
    id: `evt_pi_${n}`,
    type: 'payment_intent.succeeded',
    created: T0 + n,
    data: { object: { id: `pi_${n}`, amount_received: cents, metadata: meta } },
  };
}

function declined(n: number) {
  hooks.events[`declined-${n}`] = {
    id: `evt_fail_${n}`,
    type: 'payment_intent.payment_failed',
    created: T0 + n,
    data: {
      object: { id: `pi_${n}`, amount: 4000, amount_received: 0, last_payment_error: { code: 'card_declined' }, metadata: META },
    },
  };
}

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
  await (stripeWebhookHandler as any)({ method: 'POST', headers: { 'stripe-signature': sig }, rawBody: Buffer.from('{}') }, res);
  return code;
}

beforeEach(() => {
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.audit.mockReset();
  hooks.audit.mockResolvedValue('audit-1');
  hooks.log.mockReset();
  hooks.feeCents = 146;
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
  docs = { [INVOICE]: { ...OPEN }, 'families/fam1': { accountBalanceCents: 0 } };
  const ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
});

const notices = (key: string) => hooks.enqueue.mock.calls.filter((c) => c[0]?.key === key);
const audits = (event: string) => hooks.audit.mock.calls.filter((c) => c[0]?.event === event);
const logged = (event: string) => hooks.log.mock.calls.filter((c) => c[0]?.event === event);
const invoiceRows = () => Object.keys(docs).filter((p) => p.startsWith(`${INVOICE}/payments/`) && docs[p] != null);

describe('#2361: a declined card on an invoice that was cancelled or written off', () => {
  it.each([
    ['cancelled', CANCELLED, 'invoice-cancelled', 'A card was declined on invoice 1029, which was cancelled. No notice was sent to the household.'],
    ['written off', WRITTEN_OFF, 'invoice-written-off', 'A card was declined on invoice 1029, which was written off. No notice was sent to the household.'],
  ])('%s: the household is told nothing, and the owner gets one line', async (_label, invoice, reason, line) => {
    docs[INVOICE] = { ...invoice };
    declined(1);

    expect(await deliver('declined-1')).toBe(200);

    expect(notices('invoice.charge.failed')).toHaveLength(0);
    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(audits('BILLING_INVOICE_FAILED')).toHaveLength(0);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')[0]![0]).toMatchObject({
      severity: 'info',
      familyId: 'fam1',
      description: line,
      payload: { invoiceId: 'inv1', stripeEventId: 'evt_fail_1', reason },
    });
    expect(docs['stripeEvents/evt_fail_1']).toMatchObject({
      appliedOutcome: 'FAILED_AFTER_PAYMENT',
      declineAfterPaymentReason: reason,
      noticeSkippedReason: 'declined-after-payment',
    });
    // Nothing written to the invoice, not even the order stamp.
    expect(docs[INVOICE]).toEqual(invoice);
  });

  it('a retry after the line failed writes it with the same reason, not "already paid"', async () => {
    docs[INVOICE] = { ...CANCELLED };
    declined(1);
    hooks.audit.mockRejectedValueOnce(new Error('activity log unavailable'));

    expect(await deliver('declined-1')).toBe(500);
    expect(await deliver('declined-1')).toBe(200);

    const lines = audits('BILLING_CARD_DECLINED_AFTER_PAYMENT');
    expect(lines).toHaveLength(2);
    expect(lines[1]![0]).toMatchObject({ payload: { reason: 'invoice-cancelled' } });
    expect(lines[1]![0].description).toContain('which was cancelled');
    expect(hooks.enqueue).not.toHaveBeenCalled();
  });

  it('a decline whose notice never went out, retried after the cancel, is closed as the owner line', async () => {
    declined(1);
    hooks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));

    expect(await deliver('declined-1')).toBe(500);
    docs[INVOICE] = { ...docs[INVOICE]!, status: 'cancelled', invoiceStatus: 'cancelled' };
    expect(await deliver('declined-1')).toBe(200);

    // The one try at the notice is the failed one; nothing after the cancel.
    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')[0]![0].payload.reason).toBe('invoice-cancelled');
  });

  it('a decline on an invoice still owed still tells the household', async () => {
    declined(1);
    expect(await deliver('declined-1')).toBe(200);
    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(0);
  });

  it('the line reads plainly with no invoice number', () => {
    expect(cardDeclinedAfterPaymentWords('', 'invoice-cancelled')).toBe(
      'A card was declined on an invoice that was cancelled. No notice was sent to the household.',
    );
    expect(cardDeclinedAfterPaymentWords('1029', 'invoice-paid')).toBe(
      'A card was declined on invoice 1029, which was already paid. No notice was sent to the household.',
    );
  });
});

describe('#2363: a card payment on a written-off invoice', () => {
  it('is held, and the owner is told the invoice was written off', async () => {
    docs[INVOICE] = { ...WRITTEN_OFF };
    paid(1, 4000);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(docs['payments/evt_cs_1']).toMatchObject({
      appliedTo: 'unapplied',
      needsAdminDecision: true,
      creditedToAccountCents: 0,
      amountCents: 4000,
      feeCents: 146,
      duplicateCheckoutReason: 'invoice-written-off',
    });
    expect(notices('invoice.payment.unapplied')).toHaveLength(1);
    expect(notices('invoice.payment.unapplied')[0]![0].data.unappliedReason).toBe('the invoice was written off');
    expect(notices('invoice.payment.applied')).toHaveLength(0);
    // The invoice stays written off, with no money on it.
    expect(docs[INVOICE]).toMatchObject({ status: 'written_off', amountDueCents: 0 });
    expect(docs[INVOICE]!.paidCents).toBeUndefined();
    expect(invoiceRows()).toEqual([]);
  });
});

describe('#2370: a held payment whose fee lookup fails', () => {
  it.each([
    ['cancelled', CANCELLED],
    ['written off', WRITTEN_OFF],
    ['already paid', { ...OPEN, status: 'paid', amountDue: 0, amountDueCents: 0 }],
  ])('%s: held with no fee, and warned about like an applied one', async (_label, invoice) => {
    docs[INVOICE] = { ...invoice };
    hooks.feeCents = null;
    paid(1, 4000);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expect(docs['payments/evt_cs_1']).toMatchObject({ needsAdminDecision: true, feeResolved: false });
    expect(docs['payments/evt_cs_1']!.feeCents).toBeUndefined();
    // Once: the sibling event and the replay wrote nothing.
    expect(logged('stripe.fee.unresolved')).toHaveLength(1);
    expect(logged('stripe.fee.unresolved')[0]![0]).toMatchObject({
      severity: 'warn',
      extra: { invoiceId: 'inv1', familyId: 'fam1', eventId: 'evt_cs_1' },
    });
  });

  it('a held payment whose fee was found writes no warning', async () => {
    docs[INVOICE] = { ...CANCELLED };
    paid(1, 4000);
    expect(await deliver('session-1')).toBe(200);
    expect(logged('stripe.fee.unresolved')).toHaveLength(0);
  });
});

describe('#2345: a card payment on an invoice that was not in a state to be paid', () => {
  const NO_TOTAL = { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'open', amountDue: 100, amountDueCents: 10000 };
  const paidLines = () => audits('BILLING_INVOICE_PAID');

  it('a short card payment leaves the rest owing, and the owner gets a line', async () => {
    docs[INVOICE] = { ...NO_TOTAL };
    paid(1, 6000);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    const inv = docs[INVOICE]!;
    expect(inv).toMatchObject({ amountDueCents: 4000, amountDue: 40, paidCents: 6000, paymentStatus: 'PARTIAL' });
    expect(inv.status).not.toBe('paid');
    expect(inv.paidAt).toBeUndefined();
    // Not stamped settled: the field would hold it paid whatever its rows say.
    expect(inv.cardApplyFallback).toBeUndefined();
    expect(docs[`${INVOICE}/payments/stripe_pi_1`]).toMatchObject({ amountCents: 6000 });
    expect(docs['payments/evt_cs_1']).toMatchObject({
      appliedCents: 6000,
      tipCents: 0,
      settlesInvoice: false,
      cardApplyFallback: 'no_recorded_balance',
    });
    expect(paidLines()).toHaveLength(1);
    expect(paidLines()[0]![0]).toMatchObject({
      severity: 'warn',
      description: 'A card payment of $60.00 was put on invoice 1029, but the invoice showed a balance and had no total.',
      payload: { invoiceId: 'inv1', stripeEventId: 'evt_cs_1', cardApplyFallback: 'no_recorded_balance' },
    });
    expect(notices('invoice.payment.applied')).toHaveLength(1);
  });

  it('one that covers the balance marks it paid, with the same line', async () => {
    docs[INVOICE] = { ...NO_TOTAL };
    paid(1, 10000);

    expect(await deliver('session-1')).toBe(200);

    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0, paidCents: 10000, cardApplyFallback: 'no_recorded_balance' });
    expect(docs['payments/evt_cs_1']).toMatchObject({ settlesInvoice: true });
    expect(paidLines()[0]![0]).toMatchObject({ severity: 'warn', payload: { cardApplyFallback: 'no_recorded_balance' } });
  });

  it.each([
    ['a draft', { ...OPEN, status: 'draft' }, 'the invoice was a draft or a quote when the payment arrived'],
    ['a quote', { ...OPEN, status: 'quote' }, 'the invoice was a draft or a quote when the payment arrived'],
    ['a credit', { ...OPEN, status: 'credit' }, 'the invoice could not take a payment when it arrived'],
  ])('%s: the owner gets a line naming it', async (_label, invoice, why) => {
    docs[INVOICE] = { ...invoice };
    paid(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    expect(paidLines()).toHaveLength(1);
    expect(paidLines()[0]![0].severity).toBe('warn');
    expect(paidLines()[0]![0].description).toBe(`A card payment of $40.00 was put on invoice 1029, but ${why}.`);
  });

  it('a checkout for a different household: the owner gets a line', async () => {
    paid(1, 4000, { ...META, familyId: 'fam2', kinfolkId: 'fam2' });

    expect(await deliver('session-1')).toBe(200);

    expect(paidLines()[0]![0].description).toBe(
      'A card payment of $40.00 was put on invoice 1029, but the checkout was for a different household.',
    );
  });

  it('an invoice brought over part paid, then paid off by card: the ordinary line, nothing to say', async () => {
    // The stated balance is lower than the rows leave owing (an older payment has no row).
    docs[INVOICE] = { ...OPEN, amountDue: 10, amountDueCents: 1000 };
    paid(1, 1000);

    expect(await deliver('session-1')).toBe(200);

    expect(docs[INVOICE]).toMatchObject({ status: 'paid', cardApplyFallback: 'stated_balance_below_recorded_payments' });
    expect(paidLines()).toHaveLength(1);
    expect(paidLines()[0]![0].severity).toBe('info');
    expect(paidLines()[0]![0].description).toBeUndefined();
    expect(paidLines()[0]![0].payload.cardApplyFallback).toBeUndefined();
  });

  it('an ordinary card payment: the ordinary line', async () => {
    paid(1, 4000);
    expect(await deliver('session-1')).toBe(200);
    expect(paidLines()[0]![0].severity).toBe('info');
    expect(paidLines()[0]![0].description).toBeUndefined();
  });

  it('the line failing answers 500, and the retry writes the same line once', async () => {
    docs[INVOICE] = { ...OPEN, status: 'draft' };
    paid(1, 4000);
    hooks.audit.mockRejectedValueOnce(new Error('activity log unavailable'));

    expect(await deliver('session-1')).toBe(500);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    const lines = paidLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]![0]).toMatchObject({
      severity: 'warn',
      description: 'A card payment of $40.00 was put on invoice 1029, but the invoice was a draft or a quote when the payment arrived.',
      payload: { cardApplyFallback: 'apply_invoice_not_sent' },
    });
    // The same deterministic Activity Log id both times, so the log holds one.
    expect(lines[0]![0].docId).toBe(lines[1]![0].docId);
    expect(invoiceRows()).toHaveLength(1);
    expect(notices('invoice.payment.applied')).toHaveLength(1);
  });

  it('a cancelled invoice is held, and gets the held line only', async () => {
    docs[INVOICE] = { ...CANCELLED };
    paid(1, 4000);
    expect(await deliver('session-1')).toBe(200);
    expect(paidLines()).toHaveLength(0);
    expect(audits('BILLING_PAYMENT_UNAPPLIED')).toHaveLength(1);
  });

  it('reads the detail back off the ledger row, and none off an ordinary one', () => {
    expect(notPayableDetailOf({ cardApplyFallback: 'apply_invoice_not_sent', appliedInvoiceNumber: '1029', amountCents: 4000 })).toEqual({
      reason: 'apply_invoice_not_sent',
      invoiceNumber: '1029',
      amountCents: 4000,
    });
    expect(notPayableDetailOf({ cardApplyFallback: 'stated_balance_below_recorded_payments' })).toBeNull();
    expect(notPayableDetailOf({ amountCents: 4000 })).toBeNull();
    expect(notPayableDetailOf(undefined)).toBeNull();
  });

  it('the line for an invoice that could not be found, and one with no number', () => {
    expect(cardPaymentNotPayableWords('', 'apply_invoice_not_found', 4000)).toBe(
      'A card payment of $40.00 was recorded for an invoice that could not be found.',
    );
    expect(cardPaymentNotPayableWords('', 'apply_invoice_not_sent', 0)).toBe(
      'A card payment was put on an invoice, but the invoice was a draft or a quote when the payment arrived.',
    );
  });
});
