import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2410: NO CHECKOUT FOR A PAYMENT THE INVOICE COULD NOT TAKE.
 *
 * Since #2385 the webhook keeps a card payment off an invoice that cannot take
 * it and leaves it for the owner. `payInvoice` did not ask the same question,
 * so for three shapes it still sent the household to Stripe: an invoice that
 * states a balance and has no total, a credit that states a positive balance,
 * and an invoice whose payment rows already cover its total while it states a
 * balance. The card was charged, the invoice still read owed, and it could be
 * paid again.
 *
 * Every case below runs ONE invoice through the three sides for real, against
 * one in-memory Firestore: `getMyInvoices` (what the screens are told),
 * `payInvoice` (whether a checkout opens) and `stripeWebhook` (what a card
 * payment of the stated balance becomes). They must agree: a checkout opens
 * only for a payment the webhook would put on the invoice, and the screens are
 * told no Pay exactly when the checkout would be refused. Only Stripe is
 * stubbed.
 */

const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
  events: {} as Record<string, unknown>,
  createSession: vi.fn(),
  retrieveSession: vi.fn(),
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
    checkout: { sessions: { create: hooks.createSession, retrieve: hooks.retrieveSession } },
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
import { payInvoiceHandler } from '../src/portal/payInvoice';
import { getMyInvoicesHandler } from '../src/portal/getMyInvoices';
import type { InvoiceDoc } from '../src/admin/markInvoicePaid';
import { amountDueCentsOf } from '../src/lib/amountDueRule';
import {
  cardCheckoutRefusal,
  cardCheckoutRefusalSentence,
  INVOICE_CANNOT_TAKE_PAYMENT,
  INVOICE_CANNOT_TAKE_PAYMENT_CODE,
} from '../src/lib/cardPaymentApply';
import { checkoutRoundOf, type DuplicateCheckoutReason } from '../src/lib/invoiceCheckoutDedupe';
import { paidCentsFromPayments, type PaymentAmount } from '../src/lib/invoiceMath';
import { PAID_INVOICE_REFUSAL } from '../src/lib/invoicePaidGate';

type Docs = Record<string, Record<string, any> | null>;
let docs: Docs;

const INVOICE = 'invoices/inv1';
const UID = 'kin-uid-1';
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
const PAY = {
  invoiceId: 'inv1',
  successUrl: 'https://kinfolk.tribetails.com/invoices/inv1?checkout=done',
  cancelUrl: 'https://kinfolk.tribetails.com/invoices/inv1',
};
const QUOTE_SENTENCE = 'This quote has not been accepted, so there is nothing to pay yet.';
const CREDIT_SENTENCE = 'This is a credit, not a bill, so there is nothing to pay.';

function seed(invoice: Record<string, unknown>, rows: PaymentAmount[] = []) {
  docs = {
    'clients/kin-uid-1': { kinfolkIds: ['fam1'] },
    'families/fam1': { accountBalanceCents: 0 },
    [INVOICE]: { ...invoice },
  };
  rows.forEach((row, i) => {
    docs[`${INVOICE}/payments/row${i + 1}`] = { ...row };
  });
  const ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
  return ctx;
}

async function pay(): Promise<{ ok?: { amountCents: number; sessionId: string }; err?: any }> {
  return payInvoiceHandler({ data: PAY, auth: { uid: UID, token: {} } } as any).then(
    (ok) => ({ ok }),
    (err) => ({ err }),
  );
}

async function listed() {
  const res = await getMyInvoicesHandler({ data: { kinfolkId: 'fam1' }, auth: { uid: UID, token: {} } } as any);
  return [...res.open, ...res.paid, ...res.credits].find((i) => i.id === 'inv1');
}

/** Delivers the paid event of a checkout for `cents`, minted in the invoice's current round. */
async function cardPaymentLands(cents: number): Promise<Record<string, any>> {
  hooks.events['session-1'] = {
    id: 'evt_cs_1',
    type: 'checkout.session.completed',
    created: 1_763_000_001,
    data: {
      object: {
        id: 'cs_1',
        payment_intent: 'pi_1',
        payment_status: 'paid',
        amount_total: cents,
        metadata: {
          familyId: 'fam1',
          kinfolkId: 'fam1',
          invoiceId: 'inv1',
          uid: UID,
          checkoutRound: String(checkoutRoundOf(docs[INVOICE]?.stripeCheckoutRound)),
        },
      },
    },
  };
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
    { method: 'POST', headers: { 'stripe-signature': 'session-1' }, rawBody: Buffer.from('{}') },
    res,
  );
  expect(code).toBe(200);
  return docs['payments/evt_cs_1'] ?? {};
}

beforeEach(() => {
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.audit.mockReset();
  hooks.audit.mockResolvedValue('audit-1');
  hooks.log.mockReset();
  hooks.createSession.mockReset();
  hooks.createSession.mockResolvedValue({ id: 'cs_new', url: 'https://checkout.stripe.com/test' });
  hooks.retrieveSession.mockReset();
  hooks.retrieveSession.mockRejectedValue(new Error('No such checkout.session'));
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
});

type Case = [label: string, invoice: Record<string, unknown>, rows: PaymentAmount[], reason: DuplicateCheckoutReason];

/** Invoices `payInvoice` opened a checkout for, whose payment the webhook then kept off the invoice. */
const REFUSED: Case[] = [
  [
    'a balance and no total',
    { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'open', amountDue: 100, amountDueCents: 10000 },
    [],
    'invoice-no-balance',
  ],
  ['a balance and a total of zero', { ...OPEN, total: 0, totalCents: 0 }, [], 'invoice-no-balance'],
  // The total is read as a number only, so one stored as text is no total.
  ['a balance and a total stored as text', { kinfolkId: 'fam1', status: 'open', total: '40', amountDue: 40 }, [], 'invoice-no-balance'],
  ['payment rows that already cover the total while a balance is stated', { ...OPEN }, [{ amountCents: 4000 }], 'invoice-no-balance'],
  [
    'payment rows that come to more than the total while a balance is stated',
    { ...OPEN, amountDue: 15, amountDueCents: 1500 },
    [{ amountCents: 2500 }, { amount: 20 }],
    'invoice-no-balance',
  ],
  ['a credit that states a positive balance', { ...OPEN, status: 'credit' }, [], 'invoice-credit'],
  ['a redeemed credit that states a positive balance', { ...OPEN, status: 'redeemed', creditRedeemedAt: 'ts' }, [], 'invoice-credit'],
  [
    'a negative total with a positive balance',
    { kinfolkId: 'fam1', status: 'open', total: -25, totalCents: -2500, amountDue: 25, amountDueCents: 2500 },
    [],
    'invoice-credit',
  ],
  ['a quote the household has not answered (#2264)', { ...OPEN, status: 'quote' }, [], 'invoice-not-sent'],
  ['a quote the household declined (#2264)', { ...OPEN, status: 'quote', quoteDecision: 'denied' }, [], 'invoice-not-sent'],
];

/** Invoices that must stay payable: the webhook puts their payment on the invoice. */
const PAYABLE: Case[] = [
  ['an ordinary open invoice', { ...OPEN }, [], null],
  ['a part-paid invoice', { ...OPEN, amountDue: 25, amountDueCents: 2500, paidCents: 1500 }, [{ amountCents: 1500 }], null],
  // An older payment has no row, so the stated balance is lower than the rows leave owing.
  ['an invoice brought over part paid, with no payment rows', { ...OPEN, amountDue: 10, amountDueCents: 1000 }, [], null],
  ['a migrated invoice that states a total and no balance', { kinfolkId: 'fam1', status: 'sent', total: 40 }, [], null],
  ['a quote the household accepted (#2264)', { ...OPEN, status: 'open', quoteDecision: 'accepted' }, [], null],
  [
    'an invoice whose balance came back after an earlier card payment',
    {
      ...OPEN,
      total: 80,
      totalCents: 8000,
      paidCents: 4000,
      stripeCheckoutRound: 1,
      stripeSettledPaymentIntentId: 'pi_earlier',
    },
    [{ amountCents: 4000 }],
    null,
  ],
];

const chargeOf = (invoice: Record<string, unknown>, rows: PaymentAmount[]) =>
  amountDueCentsOf(invoice, paidCentsFromPayments(rows));

describe('#2410: payInvoice opens no checkout for a payment the webhook would keep off the invoice', () => {
  it.each(REFUSED)('%s: refused, with nothing created in Stripe and the invoice left as it was', async (_label, invoice, rows, reason) => {
    seed(invoice, rows);
    const before = { ...docs[INVOICE] };

    const { ok, err } = await pay();

    expect(ok).toBeUndefined();
    expect(err).toMatchObject({
      code: 'failed-precondition',
      message: cardCheckoutRefusalSentence(reason!),
      details: { code: INVOICE_CANNOT_TAKE_PAYMENT_CODE },
    });
    expect(hooks.createSession).not.toHaveBeenCalled();
    expect(hooks.retrieveSession).not.toHaveBeenCalled();
    expect(docs[INVOICE]).toEqual(before);
    expect(hooks.log.mock.calls.filter((c) => c[0]?.event === 'portal.invoice.checkout.refused.unpayable')).toEqual([
      [expect.objectContaining({ function: 'payInvoice', uid: UID, extra: expect.objectContaining({ invoiceId: 'inv1', reason }) })],
    ]);
  });

  it.each(REFUSED)('%s: and the webhook does keep a card payment of that balance off the invoice', async (_label, invoice, rows, reason) => {
    seed(invoice, rows);
    const row = await cardPaymentLands(chargeOf(invoice, rows));
    expect(row).toMatchObject({ needsAdminDecision: true, appliedToInvoice: false, duplicateCheckoutReason: reason });
  });

  it.each(PAYABLE)('%s: a checkout opens for the stated balance', async (_label, invoice, rows) => {
    seed(invoice, rows);

    const { ok, err } = await pay();

    expect(err).toBeUndefined();
    expect(ok).toMatchObject({ sessionId: 'cs_new', amountCents: chargeOf(invoice, rows) });
    expect(hooks.createSession).toHaveBeenCalledTimes(1);
    expect(hooks.createSession.mock.calls[0]![0].line_items[0].price_data.unit_amount).toBe(chargeOf(invoice, rows));
    expect(docs[INVOICE]).toMatchObject({ pendingCheckoutSessionId: 'cs_new' });
  });

  it.each(PAYABLE)('%s: and the webhook puts that card payment on the invoice', async (_label, invoice, rows) => {
    seed(invoice, rows);
    const row = await cardPaymentLands(chargeOf(invoice, rows));
    expect(row.needsAdminDecision).toBeUndefined();
    expect(row.duplicateCheckoutReason).toBeUndefined();
    expect(docs[`${INVOICE}/payments/stripe_pi_1`]).toBeDefined();
  });

  it.each([...REFUSED, ...PAYABLE])('%s: the rule on its own gives the reason the webhook gives', (_label, invoice, rows, reason) => {
    expect(cardCheckoutRefusal({ invoiceId: 'inv1', doc: invoice as InvoiceDoc, existingPayments: rows, kinfolkId: 'fam1' })).toBe(reason);
  });

  it('a refused invoice with a checkout already open is not handed that checkout back', async () => {
    seed({ kinfolkId: 'fam1', status: 'open', amountDue: 100, amountDueCents: 10000, pendingCheckoutSessionId: 'cs_open_1' });
    hooks.retrieveSession.mockResolvedValue({
      id: 'cs_open_1',
      url: 'https://checkout.stripe.com/open',
      status: 'open',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      amount_total: 10000,
      success_url: PAY.successUrl,
      cancel_url: PAY.cancelUrl,
      metadata: { invoiceId: 'inv1', checkoutRound: '0' },
    });
    const before = { ...docs[INVOICE] };

    const { ok, err } = await pay();

    expect(ok).toBeUndefined();
    expect(err).toMatchObject({ code: 'failed-precondition', message: INVOICE_CANNOT_TAKE_PAYMENT });
    expect(hooks.retrieveSession).not.toHaveBeenCalled();
    expect(hooks.createSession).not.toHaveBeenCalled();
    expect(docs[INVOICE]).toEqual(before);
  });

  it('the earlier refusals keep their own sentences: a paid invoice is still told it is paid', async () => {
    seed({ ...OPEN, status: 'paid' });
    const { err } = await pay();
    expect(err).toMatchObject({ message: PAID_INVOICE_REFUSAL, details: { code: 'invoice_already_paid' } });
    expect(hooks.createSession).not.toHaveBeenCalled();
  });

  it('says each reason in plain words, with no code, id or field name in it', () => {
    expect(cardCheckoutRefusalSentence('invoice-no-balance')).toBe(
      'This invoice cannot take a payment right now. Please ask your Auntie to check it.',
    );
    expect(cardCheckoutRefusalSentence('invoice-not-payable')).toBe(INVOICE_CANNOT_TAKE_PAYMENT);
    expect(cardCheckoutRefusalSentence('invoice-credit')).toBe(CREDIT_SENTENCE);
    expect(cardCheckoutRefusalSentence('invoice-not-sent')).toBe(QUOTE_SENTENCE);
    expect(cardCheckoutRefusalSentence('invoice-marked-paid')).toBe(PAID_INVOICE_REFUSAL);
    expect(cardCheckoutRefusalSentence('invoice-cancelled')).toBe('There is nothing to pay on this invoice.');
    const reasons: Array<Exclude<DuplicateCheckoutReason, null>> = [
      'stale-round',
      'settled-by-other-intent',
      'invoice-not-owed',
      'invoice-marked-paid',
      'invoice-cancelled',
      'invoice-written-off',
      'invoice-not-found',
      'invoice-other-household',
      'invoice-not-sent',
      'invoice-credit',
      'invoice-no-balance',
      'invoice-not-payable',
    ];
    for (const reason of reasons) {
      const sentence = cardCheckoutRefusalSentence(reason);
      expect(sentence, reason).toMatch(/^[A-Z][^_\u2014\u2013]*\.$/);
      expect(sentence, reason).not.toMatch(/held|unapplied|inv1|amountDue|total/i);
    }
  });
});

describe('#2410: getMyInvoices tells the screens there is no Pay, by the same rule', () => {
  /** The refused shapes the screens would otherwise offer Pay on: stamped open, a balance, not paid. */
  const offered = REFUSED.filter(([, invoice]) => invoice.status === 'open');
  const notOffered = REFUSED.filter(([, invoice]) => invoice.status !== 'open');

  it('covers the shapes the issue names', () => {
    expect(offered.map(([label]) => label)).toEqual([
      'a balance and no total',
      'a balance and a total of zero',
      'a balance and a total stored as text',
      'payment rows that already cover the total while a balance is stated',
      'payment rows that come to more than the total while a balance is stated',
      'a negative total with a positive balance',
    ]);
  });

  it.each(offered)('%s: ships the sentence and no pay methods, and the checkout is refused with the same sentence', async (_label, invoice, rows, reason) => {
    seed(invoice, rows);

    const dto = await listed();

    expect(dto).toMatchObject({ status: 'open', isPaid: false, payBlockedReason: cardCheckoutRefusalSentence(reason!), payMethods: [] });
    expect(dto!.amountDue).toBeGreaterThan(0);
    const { err } = await pay();
    expect(err?.message).toBe(dto!.payBlockedReason);
  });

  it.each(PAYABLE)('%s: ships no reason and the card, and the checkout opens', async (_label, invoice, rows) => {
    seed(invoice, rows);

    const dto = await listed();

    expect(dto!.payBlockedReason).toBeNull();
    expect(dto!.payMethods.map((m) => m.id)).toContain('stripe');
    const { ok } = await pay();
    expect(ok?.sessionId).toBe('cs_new');
  });

  it.each(notOffered)('%s: no screen offers Pay on it by its status, so it carries no reason', async (_label, invoice, rows) => {
    seed(invoice, rows);
    const dto = await listed();
    expect(dto!.status).not.toBe('open');
    expect(dto!.payBlockedReason).toBeNull();
  });

  it('reads the payment rows, not the paid figure stored on the invoice', async () => {
    // The stored figure says nothing was paid; the rows say the total is covered.
    seed({ ...OPEN, paidCents: 0 }, [{ amountCents: 4000 }]);
    expect((await listed())!.payBlockedReason).toBe(INVOICE_CANNOT_TAKE_PAYMENT);
    // And the other way: the stored figure says the total is covered, and there are no rows.
    seed({ ...OPEN, paidCents: 4000 });
    expect((await listed())!.payBlockedReason).toBeNull();
    expect((await pay()).ok?.sessionId).toBe('cs_new');
  });

  it('a settled invoice and an invoice with nothing owed carry no reason', async () => {
    seed({ ...OPEN, status: 'paid', amountDue: 0, amountDueCents: 0, paidCents: 4000 }, [{ amountCents: 4000 }]);
    expect(await listed()).toMatchObject({ status: 'paid', payBlockedReason: null, payMethods: [] });
    seed({ kinfolkId: 'fam1', status: 'zero', total: 0, amountDue: 0 });
    expect(await listed()).toMatchObject({ status: 'zero', payBlockedReason: null, payMethods: [] });
  });

  it('when the payment rows cannot be read it ships no reason, warns, and the checkout still refuses', async () => {
    const ctx = seed({ ...OPEN }, [{ amountCents: 4000 }]);
    // The list read works; only the rows read made from a listed invoice fails.
    const realCollection = ctx.db.collection;
    ctx.db.collection = (path: string) => {
      const col = realCollection(path);
      if (path !== 'invoices') return col;
      return {
        ...col,
        where: (...args: unknown[]) => {
          const query = col.where(...args);
          return {
            ...query,
            get: async () => {
              const snap = await query.get();
              return {
                ...snap,
                docs: snap.docs.map((d: any) => ({
                  ...d,
                  ref: {
                    ...d.ref,
                    collection: () => ({
                      get: async () => {
                        throw new Error('rows unavailable');
                      },
                    }),
                  },
                })),
              };
            },
          };
        },
      };
    };

    const dto = await listed();

    expect(dto).toMatchObject({ status: 'open', payBlockedReason: null });
    expect(dto!.payMethods.map((m) => m.id)).toContain('stripe');
    expect(hooks.log.mock.calls.filter((c) => c[0]?.event === 'portal.invoices.payRows.failed')).toHaveLength(1);
    const { err } = await pay();
    expect(err).toMatchObject({ message: INVOICE_CANNOT_TAKE_PAYMENT, details: { code: INVOICE_CANNOT_TAKE_PAYMENT_CODE } });
    expect(hooks.createSession).not.toHaveBeenCalled();
  });
});

/**
 * #2435 (operator ruling 2026-11-20): the balance is the total less what has
 * been applied. The named case, through the three sides for real: a $40 bill
 * with one $15 payment recorded that still states $40 owed.
 */
describe('#2435: a stated balance above what the rows leave is read as the rows leave it', () => {
  const STALE = { ...OPEN, paidCents: 0 };
  const ROWS: PaymentAmount[] = [{ amountCents: 1500, amount: 15 }];

  it('MyTribe ships $25 due and $15 paid, and offers Pay', async () => {
    seed(STALE, ROWS);
    const dto = await listed();
    expect(dto).toMatchObject({ status: 'open', amountDue: 25, paidCents: 1500, partiallyPaid: true, payBlockedReason: null });
    expect(dto!.payMethods.map((m) => m.id)).toContain('stripe');
  });

  it('the checkout charges $25', async () => {
    seed(STALE, ROWS);
    const { ok } = await pay();
    expect(ok).toMatchObject({ sessionId: 'cs_new', amountCents: 2500 });
    expect(hooks.createSession.mock.calls[0]![0].line_items[0].price_data.unit_amount).toBe(2500);
  });

  it('a $25 card payment settles it with no tip', async () => {
    seed(STALE, ROWS);
    const row = await cardPaymentLands(2500);
    expect(row).toMatchObject({ appliedCents: 2500, tipCents: 0 });
    expect(row.needsAdminDecision).toBeUndefined();
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0, paidCents: 4000 });
    expect(docs[`${INVOICE}/payments/stripe_pi_1`]).toMatchObject({ amountCents: 2500 });
  });

  it('a $40 payment from a checkout opened before this fix still applies $25; the rest is tip (no refunds)', async () => {
    seed(STALE, ROWS);
    const row = await cardPaymentLands(4000);
    expect(row).toMatchObject({ appliedCents: 2500, tipCents: 1500 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0 });
  });

  it('an invoice brought over part paid keeps its stated balance on all three sides', async () => {
    const BROUGHT = { ...OPEN, amountDue: 25, amountDueCents: 2500 };
    seed(BROUGHT, []);
    expect(await listed()).toMatchObject({ amountDue: 25, payBlockedReason: null });
    expect((await pay()).ok).toMatchObject({ amountCents: 2500 });
    seed(BROUGHT, []);
    const row = await cardPaymentLands(2500);
    expect(row).toMatchObject({ appliedCents: 2500, tipCents: 0 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0 });
  });
});
