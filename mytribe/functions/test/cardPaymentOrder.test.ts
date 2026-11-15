import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2344: A CARD PAYMENT THAT SUCCEEDED IS RECORDED, WHATEVER WAS HEARD FIRST.
 *
 * The Stripe webhook runs here for real against the same in-memory Firestore
 * and optimistic transactions as `cardLedgerRow.test.ts`. Only Stripe is
 * stubbed: the event the signature check hands back, and the fee lookup.
 *
 * THE DEFECT. A declined charge stamped the invoice with its own time
 * (`lastStripeEventAtMs`), and every later event dated before that stamp was
 * skipped as out of order, a paid event included. A payment whose first
 * delivery failed, retried after a declined attempt on a newer checkout, was
 * answered 200 and written nowhere, and its event id was reserved, so no
 * further retry could land it either.
 */

const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
  events: {} as Record<string, unknown>,
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
    paymentIntents: { retrieve: async () => ({ latest_charge: { balance_transaction: { fee: 146 } } }) },
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
import { cardDeclinedAfterPaymentWords } from '../src/lib/activityWords';

type Docs = Record<string, Record<string, any> | null>;
let docs: Docs;

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
/** Stripe's `created`, in seconds. `at(n)` is n seconds into the story. */
const T0 = 1_763_000_000;
const at = (n: number) => T0 + n;
const ms = (n: number) => at(n) * 1000;

/** The two events one successful card payment delivers. Signatures `session-<n>` and `intent-<n>`. */
function paid(n: number, cents: number, createdAt: number, meta: Record<string, string> = META) {
  hooks.events[`session-${n}`] = {
    id: `evt_cs_${n}`,
    type: 'checkout.session.completed',
    created: at(createdAt),
    data: {
      object: { id: `cs_${n}`, payment_intent: `pi_${n}`, payment_status: 'paid', amount_total: cents, metadata: meta },
    },
  };
  hooks.events[`intent-${n}`] = {
    id: `evt_pi_${n}`,
    type: 'payment_intent.succeeded',
    created: at(createdAt),
    data: { object: { id: `pi_${n}`, amount_received: cents, metadata: meta } },
  };
}

/** A declined charge on PaymentIntent n. Signature `declined-<n>` (or `declined-<n>-<attempt>`). */
function declined(n: number, createdAt: number, attempt = '', meta: Record<string, string> = META) {
  hooks.events[`declined-${n}${attempt ? `-${attempt}` : ''}`] = {
    id: `evt_fail_${n}${attempt ? `_${attempt}` : ''}`,
    type: 'payment_intent.payment_failed',
    created: at(createdAt),
    data: {
      object: {
        id: `pi_${n}`,
        amount: 4000,
        amount_received: 0,
        last_payment_error: { code: 'card_declined' },
        metadata: meta,
      },
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
  await (stripeWebhookHandler as any)(
    { method: 'POST', headers: { 'stripe-signature': sig }, rawBody: Buffer.from('{}') },
    res,
  );
  return code;
}

beforeEach(() => {
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.audit.mockReset();
  hooks.audit.mockResolvedValue('audit-1');
  hooks.log.mockReset();
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
  docs = { [INVOICE]: { ...OPEN }, 'families/fam1': { accountBalanceCents: 0 } };
  const ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
});

const invoiceRows = () =>
  Object.entries(docs).filter(([p, d]) => p.startsWith(`${INVOICE}/payments/`) && d != null) as Array<
    [string, Record<string, any>]
  >;
const invoiceRowsCents = () => invoiceRows().reduce((sum, [, d]) => sum + (d.amountCents as number), 0);
const ledgerRows = () =>
  Object.entries(docs).filter(([p, d]) => /^payments\/[^/]+$/.test(p) && d != null) as Array<
    [string, Record<string, any>]
  >;
const notices = (key: string) => hooks.enqueue.mock.calls.filter((c) => c[0]?.key === key);
const audits = (event: string) => hooks.audit.mock.calls.filter((c) => c[0]?.event === event);
const outcome = (eventId: string) => docs[`stripeEvents/${eventId}`]?.appliedOutcome;

/** The invoice is paid in full by exactly one card row, with the root ledger row and the claim beside it. */
function expectPaidOnceBy(n: number, ledgerEventId: string, cents = 4000) {
  expect(invoiceRows().map(([p]) => p)).toEqual([`${INVOICE}/payments/stripe_pi_${n}`]);
  expect(docs[`${INVOICE}/payments/stripe_pi_${n}`]).toMatchObject({
    amountCents: cents,
    method: 'stripe',
    stripePaymentIntentId: `pi_${n}`,
    sourcePaymentId: ledgerEventId,
  });
  expect(docs[INVOICE]).toMatchObject({
    status: 'paid',
    paymentStatus: 'PAID',
    paidCents: cents,
    amountDue: 0,
    amountDueCents: 0,
    stripeSettledPaymentIntentId: `pi_${n}`,
  });
  expect(docs[`payments/${ledgerEventId}`]).toMatchObject({
    invoiceId: 'inv1',
    amountCents: cents,
    paymentMethod: 'stripe',
    appliedInvoiceId: 'inv1',
    appliedCents: cents,
    settlesInvoice: true,
  });
  expect(docs[`stripePayments/pi_${n}`]).toMatchObject({ invoiceId: 'inv1', appliedEventId: ledgerEventId });
  expect(outcome(ledgerEventId)).toBe('PAID');
  expect(notices('invoice.payment.applied')).toHaveLength(1);
  expect(audits('BILLING_INVOICE_PAID')).toHaveLength(1);
}

/** Nothing about the invoice's money moved. */
function expectStillOpen() {
  expect(invoiceRows()).toEqual([]);
  expect(ledgerRows()).toEqual([]);
  expect(docs[INVOICE]).toMatchObject({ status: 'open', amountDue: 40, amountDueCents: 4000 });
  expect(notices('invoice.payment.applied')).toHaveLength(0);
}

describe('#2344: a payment that succeeded, heard after a declined attempt dated later', () => {
  it('is recorded: the retry of the earlier payment lands after the decline on a newer checkout', async () => {
    // Payment 1 succeeded at second 1; its first delivery never reached us.
    paid(1, 4000, 1);
    // The household tried again on a new checkout page; that card was declined.
    declined(2, 10);

    expect(await deliver('declined-2')).toBe(200);
    expectStillOpen();
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectPaidOnceBy(1, 'evt_cs_1');
    expect(outcome('evt_pi_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expect(outcome('evt_fail_2')).toBe('FAILED');
    expect(ledgerRows()).toHaveLength(1);
    // The decline was told once, and is not told again.
    expect(notices('invoice.charge.failed')).toHaveLength(1);
  });

  it('the same, with the PaymentIntent event of the payment arriving first', async () => {
    paid(1, 4000, 1);
    declined(2, 10);

    expect(await deliver('declined-2')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expectPaidOnceBy(1, 'evt_pi_1');
    expect(outcome('evt_cs_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
  });

  it('the same, when the later failure is an `invoice.payment_failed`', async () => {
    paid(1, 4000, 1);
    hooks.events['invoice-failed'] = {
      id: 'evt_inv_fail',
      type: 'invoice.payment_failed',
      created: at(10),
      data: { object: { id: 'in_9', payment_intent: 'pi_9', metadata: META } },
    };

    expect(await deliver('invoice-failed')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expectPaidOnceBy(1, 'evt_cs_1');
  });

  it('every event delivered twice: still one row, one ledger row, one notice of each kind', async () => {
    paid(1, 4000, 1);
    declined(2, 10);

    for (const sig of ['declined-2', 'declined-2', 'session-1', 'intent-1', 'session-1', 'intent-1', 'declined-2']) {
      expect(await deliver(sig)).toBe(200);
    }

    expectPaidOnceBy(1, 'evt_cs_1');
    expect(ledgerRows()).toHaveLength(1);
    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(audits('BILLING_INVOICE_FAILED')).toHaveLength(1);
  });

  it('several declines dated later, then the payment: recorded', async () => {
    paid(1, 4000, 1);
    declined(2, 10);
    declined(3, 20);

    expect(await deliver('declined-2')).toBe(200);
    expect(await deliver('declined-3')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expectPaidOnceBy(1, 'evt_cs_1');
  });
});

describe('#2344: a declined attempt, then a payment dated after it', () => {
  it('on a new checkout: the payment is recorded', async () => {
    declined(1, 1);
    paid(2, 4000, 10);

    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('session-2')).toBe(200);
    expect(await deliver('intent-2')).toBe(200);

    expectPaidOnceBy(2, 'evt_cs_2');
    expect(notices('invoice.charge.failed')).toHaveLength(1);
  });

  it('on the same checkout, the same PaymentIntent: the payment is recorded', async () => {
    declined(1, 1);
    paid(1, 4000, 5);

    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectPaidOnceBy(1, 'evt_cs_1');
  });

  it('on the same PaymentIntent, a second decline dated AFTER the success was heard first: recorded', async () => {
    // Cannot happen on one PaymentIntent at Stripe (a succeeded intent takes no
    // further attempt), but a `created` a second out is all it would take.
    paid(1, 4000, 5);
    declined(1, 6);

    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectPaidOnceBy(1, 'evt_pi_1');
  });
});

describe('#2344: a decline never undoes a payment already recorded', () => {
  it('a decline dated later, heard after the payment: the invoice stays paid, its rows untouched', async () => {
    paid(1, 4000, 1);
    declined(2, 10);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    const invoiceBefore = { ...docs[INVOICE]! };
    expect(await deliver('declined-2')).toBe(200);

    expectPaidOnceBy(1, 'evt_cs_1');
    expect(invoiceRowsCents()).toBe(4000);
    // The decline wrote nothing to the invoice, its order stamp included.
    expect(docs[INVOICE]).toEqual(invoiceBefore);
    expect(outcome('evt_fail_2')).toBe('FAILED_AFTER_PAYMENT');
    expect(notices('invoice.charge.failed')).toHaveLength(0);
  });

  it('a decline dated EARLIER, heard after the payment: the household is not told of it', async () => {
    declined(1, 1);
    paid(2, 4000, 10);

    expect(await deliver('session-2')).toBe(200);
    const invoiceBefore = JSON.stringify(docs[INVOICE]);
    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('declined-1')).toBe(200);

    // Paid is checked before the date: the owner gets the one line, whatever the decline's date.
    expect(outcome('evt_fail_1')).toBe('FAILED_AFTER_PAYMENT');
    expect(JSON.stringify(docs[INVOICE])).toBe(invoiceBefore);
    expect(notices('invoice.charge.failed')).toHaveLength(0);
    expect(audits('BILLING_INVOICE_FAILED')).toHaveLength(0);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(1);
    expectPaidOnceBy(2, 'evt_cs_2');
  });

  it('an older payment landing does not wind the stamp back, and a decline heard after it is not told', async () => {
    paid(1, 4000, 5);
    declined(2, 10);
    declined(3, 7);

    expect(await deliver('declined-2')).toBe(200);
    expect(await deliver('session-1')).toBe(200);
    expect(docs[INVOICE]!.lastStripeEventAtMs).toBe(ms(10));
    expect(await deliver('declined-3')).toBe(200);

    // Told once, for the decline heard while the invoice was open. The one
    // heard after the payment is the owner's line, not a notice.
    expect(outcome('evt_fail_3')).toBe('FAILED_AFTER_PAYMENT');
    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expectPaidOnceBy(1, 'evt_cs_1');
  });

  it('on an invoice still open, an older payment does not wind the stamp back: a still older decline stays skipped', async () => {
    // A part payment, so the invoice stays open and the date check is what decides.
    const legacy = { familyId: 'fam1', kinfolkId: 'fam1', invoiceId: 'inv1' };
    paid(1, 1000, 5, legacy);
    declined(2, 10, '', legacy);
    declined(3, 7, '', legacy);

    expect(await deliver('declined-2')).toBe(200);
    expect(await deliver('session-1')).toBe(200);
    expect(docs[INVOICE]).toMatchObject({ paidCents: 1000, amountDueCents: 3000, lastStripeEventAtMs: ms(10) });
    expect(docs[INVOICE]!.lastStripeEventId).toBe('evt_fail_2');
    expect(await deliver('declined-3')).toBe(200);

    expect(outcome('evt_fail_3')).toBe('SKIPPED_OUT_OF_ORDER');
    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(0);
    expect(invoiceRowsCents()).toBe(1000);
  });
});

describe('#2344: two payments on two checkouts, heard in the reverse of their dates', () => {
  it('both for the whole balance: the first heard pays the invoice, the other is held for the owner', async () => {
    paid(1, 4000, 1);
    paid(2, 4000, 10);

    expect(await deliver('session-2')).toBe(200);
    expect(await deliver('intent-2')).toBe(200);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(invoiceRows().map(([p]) => p)).toEqual([`${INVOICE}/payments/stripe_pi_2`]);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
    // Neither charge is missing from the ledger.
    expect(ledgerRows().map(([p]) => p).sort()).toEqual(['payments/evt_cs_1', 'payments/evt_cs_2']);
    expect(docs['payments/evt_cs_1']).toMatchObject({
      amountCents: 4000,
      appliedToInvoice: false,
      needsAdminDecision: true,
      creditedToAccountCents: 0,
    });
    expect(outcome('evt_cs_1')).toBe('SKIPPED_DUPLICATE_INVOICE');
    expect(outcome('evt_pi_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expect(notices('invoice.payment.applied')).toHaveLength(1);
    expect(notices('invoice.payment.unapplied')).toHaveLength(1);
    expect(docs['families/fam1']!.accountBalanceCents).toBe(0);
  });

  it('two part payments on checkouts that carry no round: both are rows on the invoice', async () => {
    // Sessions minted before the round stamp carry none, so nothing but the
    // dated order stood between the older payment and the invoice.
    const legacy = { familyId: 'fam1', kinfolkId: 'fam1', invoiceId: 'inv1' };
    docs[INVOICE] = { ...OPEN, total: 60, totalCents: 6000, amountDue: 60, amountDueCents: 6000 };
    paid(1, 2000, 1, legacy);
    paid(2, 4000, 10, legacy);

    expect(await deliver('session-2')).toBe(200);
    expect(docs[INVOICE]).toMatchObject({ paidCents: 4000, amountDueCents: 2000 });
    expect(await deliver('session-1')).toBe(200);

    expect(invoiceRows().map(([p]) => p).sort()).toEqual([
      `${INVOICE}/payments/stripe_pi_1`,
      `${INVOICE}/payments/stripe_pi_2`,
    ]);
    expect(invoiceRowsCents()).toBe(6000);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 6000, amountDueCents: 0 });
    expect(outcome('evt_cs_1')).toBe('PAID');
    expect(ledgerRows()).toHaveLength(2);
  });
});

describe('#2344: a payment the old build skipped can still be landed', () => {
  /** What the old build left behind for a paid event it skipped. */
  const skipped = (type: string) => ({
    type,
    receivedAt: '__TS__',
    eventCreatedMs: ms(1),
    familyId: 'fam1',
    invoiceId: 'inv1',
    appliedOutcome: 'SKIPPED_OUT_OF_ORDER',
  });

  it('Stripe sending the event again records the payment, once', async () => {
    paid(1, 4000, 1);
    docs[INVOICE] = { ...OPEN, lastStripeEventAtMs: ms(10), lastStripeEventId: 'evt_fail_2' };
    docs['stripeEvents/evt_cs_1'] = skipped('checkout.session.completed');
    docs['stripeEvents/evt_pi_1'] = skipped('payment_intent.succeeded');

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectPaidOnceBy(1, 'evt_cs_1');
    expect(docs['stripeEvents/evt_cs_1']).toMatchObject({
      appliedOutcome: 'PAID',
      recoveredFromOutcome: 'SKIPPED_OUT_OF_ORDER',
      followupTracked: true,
    });
    expect(outcome('evt_pi_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expect(ledgerRows()).toHaveLength(1);
    expect(docs['stripeEvents/evt_pi_1']).toMatchObject({ recoveredFromOutcome: 'SKIPPED_OUT_OF_ORDER' });
    // One line per event decided late; the third and fourth deliveries are plain replays.
    expect(
      hooks.log.mock.calls
        .filter((c) => c[0]?.event === 'stripe.outOfOrder.recovered')
        .map((c) => [c[0].extra.eventId, c[0].extra.reason]),
    ).toEqual([
      ['evt_cs_1', 'applied'],
      ['evt_pi_1', 'duplicate-payment'],
    ]);
  });

  it('a notice that fails on the recovering delivery answers 500, and the retry sends it without a second row', async () => {
    paid(1, 4000, 1);
    docs[INVOICE] = { ...OPEN, lastStripeEventAtMs: ms(10), lastStripeEventId: 'evt_fail_2' };
    docs['stripeEvents/evt_cs_1'] = skipped('checkout.session.completed');
    hooks.enqueue.mockRejectedValueOnce(new Error('queue down'));

    expect(await deliver('session-1')).toBe(500);
    expect(invoiceRows()).toHaveLength(1);
    expect(await deliver('session-1')).toBe(200);

    expect(invoiceRows().map(([p]) => p)).toEqual([`${INVOICE}/payments/stripe_pi_1`]);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', paidCents: 4000, amountDueCents: 0 });
    expect(ledgerRows()).toHaveLength(1);
    expect(outcome('evt_cs_1')).toBe('PAID');
    // Two tries at the one notice: the first threw, the second went out.
    expect(notices('invoice.payment.applied')).toHaveLength(2);
    expect(audits('BILLING_INVOICE_PAID')).toHaveLength(1);
    expect(docs['stripeEvents/evt_cs_1']!.noticeSentAt).toBeTruthy();
  });

  it('and when the invoice was paid some other way meanwhile, the charge is held for the owner', async () => {
    paid(1, 4000, 1);
    docs[INVOICE] = {
      ...OPEN,
      status: 'paid',
      paymentStatus: 'PAID',
      amountDue: 0,
      amountDueCents: 0,
      paidCents: 4000,
      lastStripeEventAtMs: ms(10),
    };
    docs[`${INVOICE}/payments/hand1`] = { amount: 40, amountCents: 4000, method: 'cash' };
    docs['stripeEvents/evt_cs_1'] = skipped('checkout.session.completed');

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expect(outcome('evt_cs_1')).toBe('SKIPPED_DUPLICATE_INVOICE');
    expect(docs['payments/evt_cs_1']).toMatchObject({ amountCents: 4000, needsAdminDecision: true, appliedToInvoice: false });
    expect(invoiceRows().map(([p]) => p)).toEqual([`${INVOICE}/payments/hand1`]);
    expect(notices('invoice.payment.unapplied')).toHaveLength(1);
    expect(notices('invoice.payment.applied')).toHaveLength(0);
  });

  it('a skipped DECLINE sent again stays skipped', async () => {
    declined(1, 1);
    docs[INVOICE] = { ...OPEN, lastStripeEventAtMs: ms(10) };
    docs['stripeEvents/evt_fail_1'] = skipped('payment_intent.payment_failed');
    const before = JSON.stringify(docs);

    expect(await deliver('declined-1')).toBe(200);

    expect(JSON.stringify(docs)).toBe(before);
    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(hooks.audit).not.toHaveBeenCalled();
  });
});

describe('#2344: a decline on an invoice already paid tells the household nothing', () => {
  const lines = () => audits('BILLING_CARD_DECLINED_AFTER_PAYMENT');
  const PAID_BY_HAND = {
    ...OPEN,
    status: 'paid',
    paymentStatus: 'PAID',
    amountDue: 0,
    amountDueCents: 0,
    paidCents: 4000,
  };
  const legacy = { familyId: 'fam1', kinfolkId: 'fam1', invoiceId: 'inv1' };

  it('a decline heard after the payment: no notice, one Activity Log line in plain words', async () => {
    paid(1, 4000, 1);
    declined(2, 10);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('declined-2')).toBe(200);
    expect(await deliver('declined-2')).toBe(200);

    expect(notices('invoice.charge.failed')).toHaveLength(0);
    expect(audits('BILLING_INVOICE_FAILED')).toHaveLength(0);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]![0]).toMatchObject({
      event: 'BILLING_CARD_DECLINED_AFTER_PAYMENT',
      severity: 'info',
      actorRole: 'SYSTEM',
      familyId: 'fam1',
      description: 'A card was declined on invoice 1029, which was already paid. No notice was sent to the household.',
      docId: 'stripe_evt_fail_2_declinedAfterPayment',
      payload: { invoiceId: 'inv1', stripeEventId: 'evt_fail_2', reason: 'invoice-paid' },
    });
    // No target on the entry: the row would end with the invoice's document id.
    expect(lines()[0]![0].targetUid).toBeUndefined();
    expect(lines()[0]![0].targetCollection).toBeUndefined();
    expect(docs['stripeEvents/evt_fail_2']).toMatchObject({
      appliedOutcome: 'FAILED_AFTER_PAYMENT',
      noticeSkippedReason: 'declined-after-payment',
      followupTracked: true,
    });
    expect(docs['stripeEvents/evt_fail_2']!.auditWrittenAt).toBeTruthy();
    expectPaidOnceBy(1, 'evt_cs_1');
  });

  it('an invoice paid by hand, then declines from an old checkout page: no notice, and nothing on the invoice moves', async () => {
    docs[INVOICE] = { ...PAID_BY_HAND };
    docs[`${INVOICE}/payments/hand1`] = { amount: 40, amountCents: 4000, method: 'cash' };
    declined(1, 10);
    hooks.events['invoice-failed'] = {
      id: 'evt_inv_fail',
      type: 'invoice.payment_failed',
      created: at(11),
      data: { object: { id: 'in_9', payment_intent: 'pi_9', metadata: META } },
    };
    const before = JSON.stringify(docs[INVOICE]);

    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('invoice-failed')).toBe(200);

    expect(JSON.stringify(docs[INVOICE])).toBe(before);
    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(lines()).toHaveLength(2);
    // A decline never claims the payment it names.
    expect(docs['stripePayments/pi_1']).toBeUndefined();
    expect(docs['stripePayments/pi_9']).toBeUndefined();
    expect(ledgerRows()).toEqual([]);
  });

  it('a decline on the checkout whose own payment has landed, on an invoice that still owes: no notice', async () => {
    // A part payment through a checkout that carries no round, so the invoice stays open.
    paid(1, 1000, 5, legacy);
    declined(1, 1, '', legacy);

    expect(await deliver('session-1')).toBe(200);
    expect(docs[INVOICE]).toMatchObject({ paidCents: 1000, amountDueCents: 3000 });
    const before = JSON.stringify(docs[INVOICE]);
    expect(await deliver('declined-1')).toBe(200);

    expect(outcome('evt_fail_1')).toBe('FAILED_AFTER_PAYMENT');
    expect(notices('invoice.charge.failed')).toHaveLength(0);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]![0].description).toBe(
      'A card was declined on invoice 1029, and the payment from the same checkout went through. No notice was sent to the household.',
    );
    expect(JSON.stringify(docs[INVOICE])).toBe(before);
    expect(invoiceRowsCents()).toBe(1000);
  });

  it('a decline on a DIFFERENT checkout of an invoice that still owes is still told', async () => {
    paid(1, 1000, 5, legacy);
    declined(2, 10, '', legacy);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('declined-2')).toBe(200);

    expect(outcome('evt_fail_2')).toBe('FAILED');
    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(audits('BILLING_INVOICE_FAILED')).toHaveLength(1);
    expect(lines()).toHaveLength(0);
    expect(docs[INVOICE]).toMatchObject({ paidCents: 1000, amountDueCents: 3000, lastStripeEventAtMs: ms(10) });
  });

  it('a decline on an open invoice is told, as before', async () => {
    declined(1, 1);

    expect(await deliver('declined-1')).toBe(200);

    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(lines()).toHaveLength(0);
    expectStillOpen();
  });

  it('a decline whose notice failed, retried after the payment landed: the notice is not sent, the line is written once', async () => {
    declined(2, 10);
    paid(1, 4000, 1);
    hooks.enqueue.mockRejectedValueOnce(new Error('queue down'));

    // The decline is recorded; its notice throws, so Stripe will try again.
    expect(await deliver('declined-2')).toBe(500);
    expect(outcome('evt_fail_2')).toBe('FAILED');
    expect(docs['stripeEvents/evt_fail_2']!.noticeSentAt).toBeUndefined();
    // The earlier payment lands before that retry.
    expect(await deliver('session-1')).toBe(200);
    const paidInvoice = JSON.stringify(docs[INVOICE]);
    expect(await deliver('declined-2')).toBe(200);
    expect(await deliver('declined-2')).toBe(200);

    // One try at the notice, the one that threw. None after the invoice was paid.
    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]![0].docId).toBe('stripe_evt_fail_2_declinedAfterPayment');
    expect(docs['stripeEvents/evt_fail_2']).toMatchObject({ noticeSkippedReason: 'declined-after-payment' });
    expect(JSON.stringify(docs[INVOICE])).toBe(paidInvoice);
    expectPaidOnceBy(1, 'evt_cs_1');
  });

  it('a decline whose notice failed, retried while the invoice is still open: the notice goes out', async () => {
    declined(2, 10);
    hooks.enqueue.mockRejectedValueOnce(new Error('queue down'));

    expect(await deliver('declined-2')).toBe(500);
    expect(await deliver('declined-2')).toBe(200);

    expect(notices('invoice.charge.failed')).toHaveLength(2);
    expect(docs['stripeEvents/evt_fail_2']!.noticeSentAt).toBeTruthy();
    expect(lines()).toHaveLength(0);
  });

  it('the Activity Log write failing answers 500, and the retry writes the line without a notice', async () => {
    docs[INVOICE] = { ...PAID_BY_HAND };
    declined(1, 10);
    hooks.audit.mockRejectedValueOnce(new Error('log down'));

    expect(await deliver('declined-1')).toBe(500);
    expect(docs['stripeEvents/evt_fail_1']!.auditWrittenAt).toBeUndefined();
    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('declined-1')).toBe(200);

    // Two tries at the one line: the first threw, the second wrote it.
    expect(lines()).toHaveLength(2);
    expect(docs['stripeEvents/evt_fail_1']!.auditWrittenAt).toBeTruthy();
    expect(hooks.enqueue).not.toHaveBeenCalled();
  });

  it('the payment landing while the decline is deciding: the decline re-reads the paid invoice and is not told', async () => {
    paid(1, 4000, 1);
    declined(2, 10);
    let fired = false;
    installOptimisticTransactions(hooks.db.current as any, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        expect(await deliver('session-1')).toBe(200);
      },
    });

    expect(await deliver('declined-2')).toBe(200);

    expect(fired).toBe(true);
    expect(outcome('evt_fail_2')).toBe('FAILED_AFTER_PAYMENT');
    expect(notices('invoice.charge.failed')).toHaveLength(0);
    expectPaidOnceBy(1, 'evt_cs_1');
  });
});

describe('#2344: the Activity Log sentence for a decline nobody is told about', () => {
  it('names the invoice by its number, and reads whole without one', () => {
    expect(cardDeclinedAfterPaymentWords('1029', 'invoice-paid')).toBe(
      'A card was declined on invoice 1029, which was already paid. No notice was sent to the household.',
    );
    expect(cardDeclinedAfterPaymentWords(undefined, 'invoice-paid')).toBe(
      'A card was declined on an invoice that was already paid. No notice was sent to the household.',
    );
    expect(cardDeclinedAfterPaymentWords('  ', 'payment-landed')).toBe(
      'A card was declined on an invoice, and the payment from the same checkout went through. No notice was sent to the household.',
    );
  });
});

describe('#2344: a paid event on an invoice that is no longer payable is never dropped', () => {
  it('after a write-off: the charge is held for the owner, and the invoice stays written off', async () => {
    docs[INVOICE] = {
      ...OPEN,
      status: 'written_off',
      amountDue: 0,
      amountDueCents: 0,
      writtenOffCents: 4000,
      lastStripeEventAtMs: ms(10),
    };
    paid(1, 4000, 1);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(outcome('evt_cs_1')).toBe('SKIPPED_DUPLICATE_INVOICE');
    expect(outcome('evt_pi_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expect(ledgerRows().map(([p]) => p)).toEqual(['payments/evt_cs_1']);
    expect(docs['payments/evt_cs_1']).toMatchObject({
      amountCents: 4000,
      appliedToInvoice: false,
      needsAdminDecision: true,
      creditedToAccountCents: 0,
    });
    expect(docs[INVOICE]).toMatchObject({ status: 'written_off', amountDueCents: 0, writtenOffCents: 4000 });
    expect(invoiceRows()).toEqual([]);
    expect(notices('invoice.payment.applied')).toHaveLength(0);
    expect(notices('invoice.payment.unapplied')).toHaveLength(1);
    expect(docs['families/fam1']!.accountBalanceCents).toBe(0);
  });

  it('on a cancelled invoice, from a checkout opened before it was cancelled: the charge is recorded with its amount', async () => {
    docs[INVOICE] = { ...OPEN, status: 'cancelled', invoiceStatus: 'cancelled', lastStripeEventAtMs: ms(10) };
    paid(1, 4000, 1);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    // Not dropped: one ledger row for the whole charge, one claim, one row on the invoice.
    expect(ledgerRows().map(([p]) => p)).toEqual(['payments/evt_cs_1']);
    expect(docs['payments/evt_cs_1']).toMatchObject({ amountCents: 4000, invoiceId: 'inv1' });
    expect(docs['stripePayments/pi_1']).toMatchObject({ invoiceId: 'inv1' });
    // It takes the fallback landing (#2276), named on the invoice, the ledger row and a warn line for the owner's report.
    expect(docs[INVOICE]).toMatchObject({ cardApplyFallback: 'apply_invoice_not_payable', paidCents: 4000 });
    expect(docs['payments/evt_cs_1']).toMatchObject({ cardApplyFallback: 'apply_invoice_not_payable', appliedCents: 4000 });
    expect(hooks.log.mock.calls.filter((c) => c[0]?.event === 'stripe.cardApply.fallback')).toHaveLength(1);
    expect(invoiceRowsCents()).toBe(4000);
    expect(outcome('evt_pi_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expect(docs['families/fam1']!.accountBalanceCents).toBe(0);
  });
});

describe('#2344: a skipped payment sent again twice at once', () => {
  const skipped = (type: string) => ({
    type,
    receivedAt: '__TS__',
    eventCreatedMs: ms(1),
    familyId: 'fam1',
    invoiceId: 'inv1',
    appliedOutcome: 'SKIPPED_OUT_OF_ORDER',
  });

  it('the same event twice, the second landing while the first is deciding: one row, one notice', async () => {
    paid(1, 4000, 1);
    docs[INVOICE] = { ...OPEN, lastStripeEventAtMs: ms(10), lastStripeEventId: 'evt_fail_2' };
    docs['stripeEvents/evt_cs_1'] = skipped('checkout.session.completed');
    let fired = false;
    let inner = 0;
    installOptimisticTransactions(hooks.db.current as any, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        inner = await deliver('session-1');
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(fired).toBe(true);
    expect(inner).toBe(200);
    expectPaidOnceBy(1, 'evt_cs_1');
    expect(ledgerRows()).toHaveLength(1);
    expect(docs['stripeEvents/evt_cs_1']).toMatchObject({ recoveredFromOutcome: 'SKIPPED_OUT_OF_ORDER' });
  });

  it('both events of the payment, one landing while the other is deciding: one row, one ledger row', async () => {
    paid(1, 4000, 1);
    docs[INVOICE] = { ...OPEN, lastStripeEventAtMs: ms(10), lastStripeEventId: 'evt_fail_2' };
    docs['stripeEvents/evt_cs_1'] = skipped('checkout.session.completed');
    docs['stripeEvents/evt_pi_1'] = skipped('payment_intent.succeeded');
    let fired = false;
    let inner = 0;
    installOptimisticTransactions(hooks.db.current as any, docs, {
      onRead: async (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        inner = await deliver('intent-1');
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(inner).toBe(200);
    expectPaidOnceBy(1, 'evt_pi_1');
    expect(outcome('evt_cs_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expect(ledgerRows()).toHaveLength(1);
    expect(invoiceRowsCents()).toBe(4000);
  });

  it('a payment recorded by hand while the skipped event is being decided: the charge is held, not applied twice', async () => {
    paid(1, 4000, 1);
    docs[INVOICE] = { ...OPEN, lastStripeEventAtMs: ms(10) };
    docs['stripeEvents/evt_cs_1'] = skipped('checkout.session.completed');
    let fired = false;
    installOptimisticTransactions(hooks.db.current as any, docs, {
      onRead: (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        docs[INVOICE] = {
          ...docs[INVOICE]!,
          status: 'paid',
          paymentStatus: 'PAID',
          amountDue: 0,
          amountDueCents: 0,
          paidCents: 4000,
        };
        docs[`${INVOICE}/payments/hand1`] = { amount: 40, amountCents: 4000, method: 'cash' };
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(outcome('evt_cs_1')).toBe('SKIPPED_DUPLICATE_INVOICE');
    expect(invoiceRows().map(([p]) => p)).toEqual([`${INVOICE}/payments/hand1`]);
    expect(docs['payments/evt_cs_1']).toMatchObject({ amountCents: 4000, needsAdminDecision: true, appliedToInvoice: false });
    expect(notices('invoice.payment.applied')).toHaveLength(0);
  });
});
