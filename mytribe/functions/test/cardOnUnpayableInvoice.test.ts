import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * CARD PAYMENTS AND DECLINES ON AN INVOICE THAT CANNOT BE PAID.
 *
 *   #2361  a declined card on a cancelled (or written-off) invoice tells the
 *          household nothing and leaves the owner one Activity Log line.
 *   #2363  a payment held on a written-off invoice says written off, not paid.
 *   #2370  a held payment whose fee lookup fails warns like an applied one.
 *   #2345  a card payment on an invoice that cannot take it (a draft, a
 *          quote, a credit, nothing owed on its total, another household's,
 *          or no invoice) is held for the owner, as one on a cancelled invoice
 *          is: the gross charge and the fee on one row, nothing on the
 *          invoice, no credit, and nothing sent to the household.
 *
 * The webhook, `listUnappliedPayments` and `resolveUnappliedPayment` run for
 * real against one in-memory Firestore with optimistic transactions, the
 * harness of `cancelledInvoiceCardPayment.test.ts`. Only Stripe is stubbed.
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
import { listUnappliedPaymentsHandler } from '../src/admin/listUnappliedPayments';
import { resolveUnappliedPaymentHandler } from '../src/admin/resolveUnappliedPayment';
import type { InvoiceDoc } from '../src/admin/markInvoicePaid';
import { cardDeclinedAfterPaymentWords, cardPaymentNotPayableWords } from '../src/lib/activityWords';
import { cardHoldReason, heldAsDuplicate, type CardApplyDecision } from '../src/lib/cardPaymentApply';
import { heldReasonForCardFallback, unappliedReasonLabel } from '../src/lib/invoiceCheckoutDedupe';

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

function declined(n: number, meta: Record<string, string> = META) {
  hooks.events[`declined-${n}`] = {
    id: `evt_fail_${n}`,
    type: 'payment_intent.payment_failed',
    created: T0 + n,
    data: {
      object: { id: `pi_${n}`, amount: 4000, amount_received: 0, last_payment_error: { code: 'card_declined' }, metadata: meta },
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

function ownerReq(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'owner1', token: { admin: true } },
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

beforeEach(() => {
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.audit.mockReset();
  hooks.audit.mockResolvedValue('audit-1');
  hooks.log.mockReset();
  hooks.feeCents = 146;
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
  docs = {
    [INVOICE]: { ...OPEN },
    // Another household, with an open invoice of its own.
    'invoices/inv9': { kinfolkId: 'fam2', invoiceNumber: '2001', status: 'open', totalCents: 4000, amountDueCents: 4000 },
    'families/fam1': { accountBalanceCents: 0 },
    'families/fam2': { accountBalanceCents: 0 },
  };
  const ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
});

const notices = (key: string) => hooks.enqueue.mock.calls.filter((c) => c[0]?.key === key);
const audits = (event: string) => hooks.audit.mock.calls.filter((c) => c[0]?.event === event);
const logged = (event: string) => hooks.log.mock.calls.filter((c) => c[0]?.event === event);
const invoiceRows = () => Object.keys(docs).filter((p) => p.startsWith(`${INVOICE}/payments/`) && docs[p] != null);
const ledgerRows = () => Object.keys(docs).filter((p) => /^payments\/[^/]+$/.test(p) && docs[p] != null);

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

  describe("a declined checkout touches only its own household's invoice", () => {
    const OTHER = { ...META, familyId: 'fam2', kinfolkId: 'fam2' };
    const LINE = 'A card was declined on invoice 1029, which belongs to a different household. No notice was sent to the household.';

    it.each([
      ['still owed', { ...OPEN }],
      ['already paid', { ...OPEN, status: 'paid', amountDue: 0, amountDueCents: 0 }],
      ['cancelled', { ...CANCELLED }],
      ['a draft', { ...OPEN, status: 'draft' }],
    ])('%s: no notice is sent, the invoice is not written, and the owner gets one line', async (_label, invoice) => {
      docs[INVOICE] = { ...invoice };
      declined(1, OTHER);

      expect(await deliver('declined-1')).toBe(200);
      expect(await deliver('declined-1')).toBe(200);

      expect(hooks.enqueue).not.toHaveBeenCalled();
      expect(audits('BILLING_INVOICE_FAILED')).toHaveLength(0);
      expect(hooks.audit).toHaveBeenCalledTimes(1);
      expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')[0]![0]).toMatchObject({
        severity: 'info',
        familyId: 'fam2',
        description: LINE,
        payload: { invoiceId: 'inv1', stripeEventId: 'evt_fail_1', reason: 'invoice-other-household' },
      });
      expect(docs['stripeEvents/evt_fail_1']).toMatchObject({
        appliedOutcome: 'FAILED_AFTER_PAYMENT',
        familyId: 'fam2',
        declineAfterPaymentReason: 'invoice-other-household',
        noticeSkippedReason: 'declined-after-payment',
      });
      // Not even the order stamp: the invoice is exactly as stored.
      expect(docs[INVOICE]).toEqual(invoice);
    });

    it('a retry after the line failed writes it with the same reason', async () => {
      declined(1, OTHER);
      hooks.audit.mockRejectedValueOnce(new Error('activity log unavailable'));

      expect(await deliver('declined-1')).toBe(500);
      expect(await deliver('declined-1')).toBe(200);

      const lines = audits('BILLING_CARD_DECLINED_AFTER_PAYMENT');
      expect(lines).toHaveLength(2);
      expect(lines[1]![0]).toMatchObject({ description: LINE, payload: { reason: 'invoice-other-household' } });
      expect(hooks.enqueue).not.toHaveBeenCalled();
      expect(docs[INVOICE]).toEqual(OPEN);
    });

    it('a decline whose notice never went out, retried after the invoice moved household, is closed as the owner line', async () => {
      declined(1);
      hooks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));

      expect(await deliver('declined-1')).toBe(500);
      docs[INVOICE] = { ...docs[INVOICE]!, kinfolkId: 'fam2' };
      expect(await deliver('declined-1')).toBe(200);

      // The one try at the notice is the failed one; nothing after the move.
      expect(notices('invoice.charge.failed')).toHaveLength(1);
      expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(1);
      expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')[0]![0].payload.reason).toBe('invoice-other-household');
    });

    it("an invoice that names no household is not another household's: the household is still told", async () => {
      docs[INVOICE] = { ...OPEN, kinfolkId: '' };
      declined(1);

      expect(await deliver('declined-1')).toBe(200);

      expect(notices('invoice.charge.failed')).toHaveLength(1);
      expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(0);
    });
  });

  it('no invoice document: no notice, no invoice made out of nothing, and the owner gets one line', async () => {
    docs[INVOICE] = null;
    declined(1);

    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('declined-1')).toBe(200);

    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(hooks.audit).toHaveBeenCalledTimes(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')[0]![0]).toMatchObject({
      familyId: 'fam1',
      description: 'A card was declined on an invoice that could not be found. No notice was sent to the household.',
      payload: { invoiceId: 'inv1', reason: 'invoice-not-found' },
    });
    expect(docs[INVOICE] ?? null).toBeNull();
  });

  it('a decline whose notice never went out, retried after the invoice was deleted, is closed as the owner line', async () => {
    declined(1);
    hooks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));

    expect(await deliver('declined-1')).toBe(500);
    docs[INVOICE] = null;
    expect(await deliver('declined-1')).toBe(200);

    expect(notices('invoice.charge.failed')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')[0]![0].payload.reason).toBe('invoice-not-found');
    expect(docs[INVOICE] ?? null).toBeNull();
  });

  it('the line reads plainly with no invoice number', () => {
    expect(cardDeclinedAfterPaymentWords('', 'invoice-other-household')).toBe(
      'A card was declined on an invoice with no number that belongs to a different household. No notice was sent to the household.',
    );
    expect(cardDeclinedAfterPaymentWords('1029', 'invoice-not-found')).toBe(
      'A card was declined on an invoice that could not be found. No notice was sent to the household.',
    );
    expect(cardDeclinedAfterPaymentWords('', 'invoice-cancelled')).toBe(
      'A card was declined on an invoice with no number that was cancelled. No notice was sent to the household.',
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

describe('#2345: a card payment on an invoice that cannot take it is held for the owner', () => {
  const NO_TOTAL = { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'open', amountDue: 100, amountDueCents: 10000 };
  const paidLines = () => audits('BILLING_INVOICE_PAID');
  /** The three fields a held payment leaves on its own household's invoice, and nothing else. */
  const BOOKKEEPING = ['duplicateCheckoutPaymentIntentIds', 'lastDuplicateCheckoutAt', 'unappliedPaymentIds'];

  /** The invoice reads as it did before the payment: no money, no status, no stamp, no row. */
  function expectInvoiceAsBefore(before: Record<string, any>, marked = true) {
    const inv = { ...docs[INVOICE]! };
    for (const key of BOOKKEEPING) {
      if (marked) expect(inv[key], key).toBeDefined();
      delete inv[key];
    }
    expect(inv).toEqual(before);
    expect(invoiceRows()).toEqual([]);
  }

  /**
   * One held payment: the gross charge and the fee on one root row, nothing
   * applied, no credit, the owner told and the household not.
   */
  function expectHeld(reason: string, cents: number, kinfolkId = 'fam1') {
    const row = docs['payments/evt_cs_1']!;
    expect(row).toMatchObject({
      kinfolkId,
      invoiceId: 'inv1',
      amountCents: cents,
      amountResolved: true,
      feeCents: 146,
      feeResolved: true,
      appliedToInvoice: false,
      appliedTo: 'unapplied',
      needsAdminDecision: true,
      creditedToAccountCents: 0,
      duplicateCheckoutReason: reason,
      duplicateOfPaymentIntentId: null,
    });
    // Nothing was applied, so the row carries no applied part, no tip and no proceeds.
    for (const key of ['appliedInvoiceId', 'appliedCents', 'tipCents', 'proceedsCents', 'settlesInvoice', 'cardApplyFallback']) {
      expect(row[key], key).toBeUndefined();
    }
    expect(ledgerRows()).toEqual(['payments/evt_cs_1']);
    expect(docs['stripePayments/pi_1']).toMatchObject({ appliedEventId: 'evt_cs_1', appliedOutcome: 'DUPLICATE_INVOICE_CHECKOUT' });
    expect(docs['stripeEvents/evt_cs_1']).toMatchObject({
      appliedOutcome: 'SKIPPED_DUPLICATE_INVOICE',
      duplicateReason: reason,
      unappliedCents: cents,
    });
    // No credit to anyone.
    expect(docs['families/fam1']).toEqual({ accountBalanceCents: 0 });
    expect(docs['families/fam2']).toEqual({ accountBalanceCents: 0 });
    // The owner's notice and line, and nothing to the household.
    expect(hooks.enqueue.mock.calls.map((c) => c[0].key)).toEqual(['invoice.payment.unapplied']);
    expect(notices('invoice.payment.unapplied')[0]![0]).toMatchObject({
      recipientUid: '',
      data: { kinfolkId, invoiceId: 'inv1', stripeEventId: 'evt_cs_1', unappliedReason: unappliedReasonLabel(reason) },
    });
    expect(hooks.audit).toHaveBeenCalledTimes(1);
    expect(audits('BILLING_PAYMENT_UNAPPLIED')[0]![0]).toMatchObject({
      severity: 'critical',
      familyId: kinfolkId,
      payload: { invoiceId: 'inv1', paymentId: 'evt_cs_1', duplicateReason: reason, unappliedCents: cents },
    });
    expect(paidLines()).toHaveLength(0);
    expect(logged('stripe.cardApply.fallback')).toHaveLength(0);
  }

  it.each([
    ['a draft', { ...OPEN, status: 'draft' }, 'invoice-not-sent'],
    ['a quote saved unsent', { ...OPEN, status: 'draft', invoiceStatus: 'draft', quoteDraft: true }, 'invoice-not-sent'],
    ['a quote', { ...OPEN, status: 'quote' }, 'invoice-not-sent'],
    ['a credit by its label', { ...OPEN, status: 'credit' }, 'invoice-credit'],
    [
      'a credit with a negative balance',
      { ...OPEN, status: 'credit', total: -25, totalCents: -2500, amountDue: -25, amountDueCents: -2500 },
      'invoice-credit',
    ],
    ['a negative total and no balance stated', { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'open', total: -25 }, 'invoice-credit'],
    [
      'a credit already redeemed',
      { ...OPEN, status: 'redeemed', total: -25, totalCents: -2500, amountDue: 0, amountDueCents: 0, creditRedeemedAt: 'ts' },
      'invoice-credit',
    ],
    ['a balance with no total', NO_TOTAL, 'invoice-no-balance'],
  ])('%s: held whole, and the invoice is left as it was', async (_label, invoice, reason) => {
    docs[INVOICE] = { ...invoice };
    paid(1, 4000);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expectHeld(reason, 4000);
    expectInvoiceAsBefore(invoice);
    // The second event of the same charge wrote its own record and nothing else.
    expect(docs['stripeEvents/evt_pi_1']).toMatchObject({ appliedOutcome: 'SKIPPED_DUPLICATE_PAYMENT' });
  });

  it('the payment event arriving ahead of the checkout event: held once, by whichever came first', async () => {
    docs[INVOICE] = { ...OPEN, status: 'quote' };
    paid(1, 4000);

    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(ledgerRows()).toEqual(['payments/evt_pi_1']);
    expect(docs['payments/evt_pi_1']).toMatchObject({
      amountCents: 4000,
      feeCents: 146,
      appliedTo: 'unapplied',
      duplicateCheckoutReason: 'invoice-not-sent',
    });
    expect(docs['stripeEvents/evt_cs_1']).toMatchObject({ appliedOutcome: 'SKIPPED_DUPLICATE_PAYMENT' });
    expect(hooks.enqueue.mock.calls.map((c) => c[0].key)).toEqual(['invoice.payment.unapplied']);
    expect(hooks.audit).toHaveBeenCalledTimes(1);
    expectInvoiceAsBefore({ ...OPEN, status: 'quote' });
  });

  it('a quote paid short: the whole charge is held, and the quote can still be answered', async () => {
    const quote = { ...OPEN, status: 'quote', quoteSentAt: 'ts' };
    docs[INVOICE] = { ...quote };
    paid(1, 2500);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectHeld('invoice-not-sent', 2500);
    // Still a quote for the full amount: no payment, no part-paid label, no state stamp.
    expectInvoiceAsBefore(quote);
    expect(docs[INVOICE]).toMatchObject({ status: 'quote', amountDueCents: 4000 });
  });

  it('a draft paid over its total: the whole charge is held, and none of it is called a tip', async () => {
    const draft = { ...OPEN, status: 'draft' };
    docs[INVOICE] = { ...draft };
    paid(1, 5000);

    expect(await deliver('session-1')).toBe(200);

    expectHeld('invoice-not-sent', 5000);
    expectInvoiceAsBefore(draft);
  });

  it('a balance with no total, paid short: held, and the balance is not moved', async () => {
    docs[INVOICE] = { ...NO_TOTAL };
    paid(1, 6000);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectHeld('invoice-no-balance', 6000);
    expectInvoiceAsBefore(NO_TOTAL);
  });

  it('a balance still stated on an invoice its payments already cover: held, and the payment row is not added to', async () => {
    const covered = { ...OPEN, amountDue: 20, amountDueCents: 2000 };
    docs[INVOICE] = { ...covered };
    docs[`${INVOICE}/payments/p1`] = { amountCents: 4000, method: 'cash' };
    paid(1, 2000);

    expect(await deliver('session-1')).toBe(200);

    expect(docs['payments/evt_cs_1']).toMatchObject({
      amountCents: 2000,
      appliedTo: 'unapplied',
      duplicateCheckoutReason: 'invoice-no-balance',
    });
    expect(invoiceRows()).toEqual([`${INVOICE}/payments/p1`]);
    expect(docs[INVOICE]).toMatchObject(covered);
    expect(docs[INVOICE]!.paidCents).toBeUndefined();
    expect(notices('invoice.payment.applied')).toHaveLength(0);
  });

  it('no invoice document: held, and no invoice is made out of nothing', async () => {
    docs[INVOICE] = null;
    paid(1, 4000);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectHeld('invoice-not-found', 4000);
    expect(docs[INVOICE] ?? null).toBeNull();
    expect(invoiceRows()).toEqual([]);
  });

  it('a draft Stripe gave no amount for: held with no figure invented, and not marked paid', async () => {
    const draft = { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'draft' };
    docs[INVOICE] = { ...draft };
    hooks.events['session-1'] = {
      id: 'evt_cs_1',
      type: 'checkout.session.completed',
      created: T0 + 1,
      data: { object: { id: 'cs_1', payment_intent: 'pi_1', payment_status: 'paid', amount_total: null, metadata: META } },
    };

    expect(await deliver('session-1')).toBe(200);

    expect(docs['payments/evt_cs_1']).toMatchObject({
      amountCents: null,
      amountResolved: false,
      appliedTo: 'unapplied',
      needsAdminDecision: true,
      duplicateCheckoutReason: 'invoice-not-sent',
    });
    expectInvoiceAsBefore(draft);
    expect(paidLines()).toHaveLength(0);
    expect(notices('invoice.payment.applied')).toHaveLength(0);
  });

  it('the fee lookup failing: still held whole, with no fee claimed and the warning written', async () => {
    docs[INVOICE] = { ...OPEN, status: 'draft' };
    hooks.feeCents = null;
    paid(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    expect(docs['payments/evt_cs_1']).toMatchObject({ amountCents: 4000, feeResolved: false, needsAdminDecision: true });
    expect(docs['payments/evt_cs_1']!.feeCents).toBeUndefined();
    expect(logged('stripe.fee.unresolved')).toHaveLength(1);
  });

  it("the owner's notice failing answers 500, and the retry sends it without a second row or line", async () => {
    docs[INVOICE] = { ...OPEN, status: 'draft' };
    paid(1, 4000);
    hooks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));

    expect(await deliver('session-1')).toBe(500);
    expect(ledgerRows()).toEqual(['payments/evt_cs_1']);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expect(ledgerRows()).toEqual(['payments/evt_cs_1']);
    expect(notices('invoice.payment.unapplied')).toHaveLength(2);
    expect(notices('invoice.payment.unapplied')[1]![0].data).toMatchObject({
      unappliedAmount: '$40.00',
      unappliedReason: 'the invoice was a draft or a quote',
    });
    expect(audits('BILLING_PAYMENT_UNAPPLIED')).toHaveLength(1);
    expect(notices('invoice.payment.applied')).toHaveLength(0);
    expectInvoiceAsBefore({ ...OPEN, status: 'draft' });
  });

  it("the owner's line failing answers 500, and the retry writes the same line once", async () => {
    docs[INVOICE] = { ...OPEN, status: 'credit' };
    paid(1, 4000);
    hooks.audit.mockRejectedValueOnce(new Error('activity log unavailable'));

    expect(await deliver('session-1')).toBe(500);
    expect(await deliver('session-1')).toBe(200);

    const lines = audits('BILLING_PAYMENT_UNAPPLIED');
    expect(lines).toHaveLength(2);
    expect(lines[0]![0].docId).toBe(lines[1]![0].docId);
    expect(lines[1]![0].payload).toMatchObject({ duplicateReason: 'invoice-credit', unappliedCents: 4000 });
    expect(notices('invoice.payment.unapplied')).toHaveLength(1);
    expect(ledgerRows()).toEqual(['payments/evt_cs_1']);
  });

  describe("a checkout for one household's invoice, when the invoice is another household's", () => {
    const OTHER = { ...META, familyId: 'fam2', kinfolkId: 'fam2' };

    it.each([
      ['still owed', { ...OPEN }],
      ['already paid by card', { ...OPEN, status: 'paid', amountDue: 0, amountDueCents: 0, stripeSettledPaymentIntentId: 'pi_old', stripeCheckoutRound: 1 }],
      ['cancelled', { ...CANCELLED }],
      ['written off', { ...WRITTEN_OFF }],
      ['a draft', { ...OPEN, status: 'draft' }],
      ['a balance with no total', { ...NO_TOTAL }],
    ])('%s: held for the household that paid, and the invoice is not written at all', async (_label, invoice) => {
      docs[INVOICE] = { ...invoice };
      paid(1, 4000, OTHER);

      expect(await deliver('session-1')).toBe(200);
      expect(await deliver('intent-1')).toBe(200);
      expect(await deliver('session-1')).toBe(200);

      expectHeld('invoice-other-household', 4000, 'fam2');
      expect(docs['payments/evt_cs_1']).toMatchObject({ invoiceNumber: '1029' });
      // Not even the bookkeeping fields: the invoice is exactly as stored.
      expect(docs[INVOICE]).toEqual(invoice);
      expect(invoiceRows()).toEqual([]);
    });

    it('the owner finds it under the household that paid, and cannot put it on the other invoice', async () => {
      paid(1, 4000, OTHER);
      expect(await deliver('session-1')).toBe(200);

      const theirs = await listUnappliedPaymentsHandler(ownerReq({ kinfolkId: 'fam2' }));
      expect(theirs.payments).toHaveLength(1);
      expect(theirs.payments[0]).toMatchObject({
        paymentId: 'evt_cs_1',
        kinfolkId: 'fam2',
        invoiceId: 'inv1',
        invoiceNumber: '1029',
        amountCents: 4000,
        feeCents: 146,
        reason: 'the invoice belongs to a different household',
      });
      expect(theirs.openInvoices.map((i) => i.invoiceId)).toEqual(['inv9']);
      const others = await listUnappliedPaymentsHandler(ownerReq({ kinfolkId: 'fam1' }));
      expect(others.payments).toEqual([]);

      await expect(
        resolveUnappliedPaymentHandler(
          ownerReq({
            paymentId: 'evt_cs_1',
            creditCents: 0,
            creditReason: '',
            applyInvoiceId: 'inv1',
            applyCents: 4000,
            idempotencyKey: 'upd_1790000000000_abc201',
          }),
        ),
      ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'apply_wrong_household' } });
      expect(docs[INVOICE]).toEqual(OPEN);

      const res = await resolveUnappliedPaymentHandler(
        ownerReq({
          paymentId: 'evt_cs_1',
          creditCents: 1500,
          creditReason: 'Paid by card on a checkout for another invoice',
          applyInvoiceId: 'inv9',
          applyCents: 2500,
          idempotencyKey: 'upd_1790000000000_abc202',
        }),
      );
      expect(res).toMatchObject({ ok: true, paymentCents: 4000, creditedCents: 1500, appliedCents: 2500, keptCents: 0 });
      expect(docs['families/fam2']!.accountBalanceCents).toBe(1500);
      expect(docs['families/fam1']).toEqual({ accountBalanceCents: 0 });
      expect(docs[INVOICE]).toEqual(OPEN);
    });
  });

  it('once a held draft is sent, the owner can put the payment on it', async () => {
    docs[INVOICE] = { ...OPEN, status: 'draft' };
    paid(1, 4000);
    expect(await deliver('session-1')).toBe(200);

    const listed = await listUnappliedPaymentsHandler(ownerReq({ kinfolkId: 'fam1' }));
    expect(listed.payments[0]).toMatchObject({ invoiceNumber: '1029', reason: 'the invoice was a draft or a quote' });
    // Not offered while it is a draft, and refused if asked.
    expect(listed.openInvoices).toEqual([]);
    await expect(
      resolveUnappliedPaymentHandler(
        ownerReq({
          paymentId: 'evt_cs_1',
          creditCents: 0,
          creditReason: '',
          applyInvoiceId: 'inv1',
          applyCents: 4000,
          idempotencyKey: 'upd_1790000000000_abc203',
        }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'apply_invoice_not_sent' } });

    docs[INVOICE] = { ...docs[INVOICE]!, status: 'open' };
    const res = await resolveUnappliedPaymentHandler(
      ownerReq({
        paymentId: 'evt_cs_1',
        creditCents: 0,
        creditReason: '',
        applyInvoiceId: 'inv1',
        applyCents: 4000,
        idempotencyKey: 'upd_1790000000000_abc204',
      }),
    );
    expect(res).toMatchObject({ ok: true, appliedCents: 4000, creditedCents: 0, keptCents: 0 });
    expect(docs['families/fam1']).toEqual({ accountBalanceCents: 0 });
  });

  it('an invoice brought over part paid, then paid off by card: applied, with the ordinary line', async () => {
    // The stated balance is lower than the rows leave owing (an older payment has no row).
    docs[INVOICE] = { ...OPEN, amountDue: 10, amountDueCents: 1000 };
    paid(1, 1000);

    expect(await deliver('session-1')).toBe(200);

    expect(docs[INVOICE]).toMatchObject({ status: 'paid', cardApplyFallback: 'stated_balance_below_recorded_payments' });
    expect(docs['payments/evt_cs_1']!.needsAdminDecision).toBeUndefined();
    expect(paidLines()).toHaveLength(1);
    expect(paidLines()[0]![0].severity).toBe('info');
    expect(paidLines()[0]![0].description).toBeUndefined();
    expect(paidLines()[0]![0].payload.cardApplyFallback).toBeUndefined();
    expect(notices('invoice.payment.applied')).toHaveLength(1);
  });

  it('an ordinary card payment: applied, with the ordinary line', async () => {
    paid(1, 4000);
    expect(await deliver('session-1')).toBe(200);
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0, paidCents: 4000 });
    expect(docs['payments/evt_cs_1']!.needsAdminDecision).toBeUndefined();
    expect(paidLines()[0]![0].severity).toBe('info');
    expect(paidLines()[0]![0].description).toBeUndefined();
  });

  it('a short card payment on an ordinary invoice: applied, and the rest stays owing', async () => {
    paid(1, 2500);
    expect(await deliver('session-1')).toBe(200);
    expect(docs[INVOICE]).toMatchObject({ amountDueCents: 1500, paidCents: 2500 });
    expect(docs[INVOICE]!.status).not.toBe('paid');
    expect(docs['payments/evt_cs_1']).toMatchObject({ appliedCents: 2500, settlesInvoice: false });
  });

  it('a cancelled invoice is held, and gets the held line only', async () => {
    docs[INVOICE] = { ...CANCELLED };
    paid(1, 4000);
    expect(await deliver('session-1')).toBe(200);
    expect(paidLines()).toHaveLength(0);
    expect(audits('BILLING_PAYMENT_UNAPPLIED')).toHaveLength(1);
    expect(docs['payments/evt_cs_1']).toMatchObject({ duplicateCheckoutReason: 'invoice-cancelled' });
  });
});

describe('#2345: why a card payment is held (the decision, on its own)', () => {
  const planned: CardApplyDecision = { kind: 'no-amount' };
  const ask = (doc: InvoiceDoc | null, over: Partial<Parameters<typeof cardHoldReason>[0]> = {}) =>
    cardHoldReason({ doc, existingPayments: [], kinfolkId: 'fam1', duplicate: null, landing: planned, ...over });

  it('an invoice that can take the payment is not held', () => {
    expect(ask({ ...OPEN })).toBeNull();
    // An invoice or a checkout that names no household is not another household's.
    expect(ask({ ...OPEN, kinfolkId: '' })).toBeNull();
    expect(ask({ ...OPEN }, { kinfolkId: '' })).toBeNull();
  });

  it('asks whose the invoice is before anything the invoice says about itself', () => {
    expect(ask(null, { duplicate: 'stale-round' })).toBe('invoice-not-found');
    for (const duplicate of ['invoice-cancelled', 'invoice-written-off', 'stale-round', 'invoice-not-owed', 'invoice-marked-paid'] as const) {
      expect(ask({ ...OPEN, status: 'draft' }, { kinfolkId: 'fam2', duplicate })).toBe('invoice-other-household');
    }
  });

  it('says cancelled or written off ahead of draft, quote or credit, and those ahead of the paid checks', () => {
    expect(ask({ ...OPEN, status: 'quote', invoiceStatus: 'cancelled' }, { duplicate: 'invoice-cancelled' })).toBe('invoice-cancelled');
    expect(ask({ ...OPEN, amountDue: -5, amountDueCents: -500 }, { duplicate: 'invoice-written-off' })).toBe('invoice-written-off');
    expect(ask({ ...OPEN, status: 'quote' }, { duplicate: 'stale-round' })).toBe('invoice-not-sent');
    expect(ask({ ...OPEN, status: 'draft' }, { duplicate: 'invoice-not-owed' })).toBe('invoice-not-sent');
    expect(ask({ ...OPEN, status: 'credit' }, { duplicate: 'invoice-not-owed' })).toBe('invoice-credit');
    expect(ask({ ...OPEN, amountDue: -5, amountDueCents: -500 }, { duplicate: 'invoice-not-owed' })).toBe('invoice-credit');
  });

  it('keeps the reason for a second attempt at a payment the invoice already took', () => {
    for (const duplicate of ['stale-round', 'settled-by-other-intent', 'invoice-not-owed', 'invoice-marked-paid'] as const) {
      expect(ask({ ...OPEN }, { duplicate })).toBe(duplicate);
    }
  });

  it('holds a payment with no figure when nothing is owed on the total, and not when something is', () => {
    const noAmount: CardApplyDecision = { kind: 'no-amount' };
    expect(ask({ kinfolkId: 'fam1', status: 'open' } as InvoiceDoc, { landing: noAmount })).toBe('invoice-no-balance');
    expect(ask({ ...OPEN }, { landing: noAmount, existingPayments: [{ amountCents: 4000 }] })).toBe('invoice-no-balance');
    expect(ask({ ...OPEN }, { landing: noAmount, existingPayments: [{ amountCents: 1500 }] })).toBeNull();
    expect(ask({ kinfolkId: 'fam1', status: 'open', totalCents: 4000 } as InvoiceDoc, { landing: noAmount })).toBeNull();
  });

  it('holds what the landing could not describe, and applies an invoice paid as shown', () => {
    const fallback = (reason: string): CardApplyDecision => ({
      kind: 'fallback',
      reason,
      writeRow: true,
      appliedCents: 0,
      tipCents: 0,
      paidCents: 0,
      leftOwingCents: 0,
    });
    expect(ask({ ...OPEN }, { landing: fallback('no_recorded_balance') })).toBe('invoice-no-balance');
    expect(ask({ ...OPEN }, { landing: fallback('apply_invoice_not_payable') })).toBe('invoice-not-payable');
    expect(ask({ ...OPEN }, { landing: fallback('stated_balance_below_recorded_payments') })).toBeNull();
  });

  it('maps every fallback reason, so none is applied by default', () => {
    expect(heldReasonForCardFallback('apply_invoice_not_found')).toBe('invoice-not-found');
    expect(heldReasonForCardFallback('apply_wrong_household')).toBe('invoice-other-household');
    expect(heldReasonForCardFallback('apply_invoice_not_sent')).toBe('invoice-not-sent');
    expect(heldReasonForCardFallback('no_recorded_balance')).toBe('invoice-no-balance');
    expect(heldReasonForCardFallback('invoice_already_settled')).toBe('invoice-not-payable');
    expect(heldReasonForCardFallback('stated_balance_below_recorded_payments')).toBeNull();
    expect(heldReasonForCardFallback(null)).toBeNull();
    expect(heldReasonForCardFallback(undefined)).toBeNull();
  });

  it('names the payment that settled the invoice only for a second attempt at it', () => {
    for (const reason of ['stale-round', 'settled-by-other-intent', 'invoice-not-owed', 'invoice-marked-paid', 'invoice-cancelled', 'invoice-written-off'] as const) {
      expect(heldAsDuplicate(reason)).toBe(true);
    }
    for (const reason of ['invoice-not-found', 'invoice-other-household', 'invoice-not-sent', 'invoice-credit', 'invoice-no-balance', 'invoice-not-payable', null] as const) {
      expect(heldAsDuplicate(reason)).toBe(false);
    }
  });

  it.each([
    ['invoice-not-found', 'the invoice could not be found'],
    ['invoice-other-household', 'the invoice belongs to a different household'],
    ['invoice-not-sent', 'the invoice was a draft or a quote'],
    ['invoice-credit', 'the invoice was a credit, not a bill'],
    ['invoice-no-balance', "nothing was owed on the invoice's total"],
    ['invoice-not-payable', 'the invoice could not take a payment'],
  ])('%s reads as a plain sentence after "Not applied because"', (reason, sentence) => {
    expect(unappliedReasonLabel(reason)).toBe(sentence);
  });
});

describe('#2345: the line for a payment an earlier build put on an invoice that could not take it', () => {
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

  it('a retry of such a payment whose line was never written gets the line, and nothing else is written', async () => {
    // What the build before the hold left: the invoice paid, the row flagged, the line owed.
    docs[INVOICE] = { ...OPEN, status: 'paid', amountDue: 0, amountDueCents: 0, cardApplyFallback: 'apply_invoice_not_sent' };
    docs['stripeEvents/evt_cs_1'] = { type: 'checkout.session.completed', appliedOutcome: 'PAID', followupTracked: true, noticeSentAt: 'ts' };
    docs['payments/evt_cs_1'] = {
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      amountCents: 4000,
      appliedInvoiceNumber: '1029',
      cardApplyFallback: 'apply_invoice_not_sent',
    };
    const before = { ...docs[INVOICE] };
    paid(1, 4000);

    expect(await deliver('session-1')).toBe(200);

    expect(audits('BILLING_INVOICE_PAID')).toHaveLength(1);
    expect(audits('BILLING_INVOICE_PAID')[0]![0]).toMatchObject({
      severity: 'warn',
      description: 'A card payment of $40.00 was put on invoice 1029, but the invoice was a draft or a quote when the payment arrived.',
    });
    expect(hooks.enqueue).not.toHaveBeenCalled();
    expect(docs[INVOICE]).toEqual(before);
  });

  it('the words for each reason, with and without an invoice number', () => {
    expect(cardPaymentNotPayableWords('', 'apply_invoice_not_found', 4000)).toBe(
      'A card payment of $40.00 was recorded for an invoice that could not be found.',
    );
    expect(cardPaymentNotPayableWords('', 'apply_invoice_not_sent', 0)).toBe(
      'A card payment was put on an invoice with no number, but the invoice was a draft or a quote when the payment arrived.',
    );
    expect(cardPaymentNotPayableWords('1029', 'apply_wrong_household', 4000)).toBe(
      'A card payment of $40.00 was put on invoice 1029, but the checkout was for a different household.',
    );
    expect(cardPaymentNotPayableWords('1029', 'no_recorded_balance', 6000)).toBe(
      "A card payment of $60.00 was put on invoice 1029, but nothing was owed on the invoice's total.",
    );
  });
});
