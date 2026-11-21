import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2437: NO SECOND CHECKOUT WHILE A FINISHED CARD PAYMENT IS NOT YET ON THE
 * INVOICE.
 *
 * Between a household finishing at Stripe and the card webhook recording the
 * payment, the invoice still reads owed. `payInvoice` used to open a second
 * checkout in that gap, and a second payment is a real charge the webhook
 * then holds for the owner. There are no refunds.
 *
 * `payInvoice` and `stripeWebhook` run for real here against one in-memory
 * Firestore, so the claim that says "recorded" (`stripePayments/{id}`) is the
 * one the webhook itself writes, for a payment it applied and for one it held.
 * Only Stripe is stubbed, by the small stand-in below: it keeps the sessions
 * `payInvoice` creates and lets a test say "the household paid this one".
 */

const hooks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
  events: {} as Record<string, unknown>,
  createSession: vi.fn(),
  retrieveSession: vi.fn(),
  retrieveIntent: vi.fn(),
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
    paymentIntents: { retrieve: hooks.retrieveIntent },
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
import {
  chargeTimeMsOf,
  checkoutSessionIdsToRead,
  finishedCheckoutOf,
  holdsPay,
  MAX_CHECKOUT_SESSIONS_READ,
  PAYMENT_BEING_RECORDED,
  PAYMENT_BEING_RECORDED_CODE,
  PAYMENT_RECORDING_WINDOW_MS,
} from '../src/lib/checkoutBeingRecorded';
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
const WEB = {
  successUrl: 'https://kinfolk.tribetails.com/invoices/inv1?checkout=done',
  cancelUrl: 'https://kinfolk.tribetails.com/invoices/inv1',
};
/** The two addresses an Android build from before #2366 still sends. */
const OLD_ANDROID = {
  successUrl: 'https://kinfolk.tribetails.com/portal/payment-success',
  cancelUrl: 'https://kinfolk.tribetails.com/portal/payment-cancel',
};
const NOW = Date.parse('2026-11-20T18:00:00Z');

// ── The Stripe stand-in ─────────────────────────────────────────────────────
interface FakeSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  payment_intent: string | null;
  created: number;
  expires_at: number;
  amount_total: number;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, string>;
}
let sessions: Map<string, FakeSession>;
let intents: Map<string, { id: string; latest_charge: { created: number; balance_transaction: { fee: number } } }>;

/** Puts a session at Stripe that `payInvoice` did not just create (an older one, already stored on the invoice). */
function sessionAtStripe(id: string, over: Partial<FakeSession> = {}): FakeSession {
  const s: FakeSession = {
    id,
    url: `https://checkout.stripe.com/${id}`,
    status: 'open',
    payment_status: 'unpaid',
    payment_intent: null,
    created: Math.floor(Date.now() / 1000),
    expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
    amount_total: 4000,
    success_url: WEB.successUrl,
    cancel_url: WEB.cancelUrl,
    metadata: { invoiceId: 'inv1', familyId: 'fam1', kinfolkId: 'fam1', uid: UID, checkoutRound: '0' },
    ...over,
  };
  sessions.set(id, s);
  return s;
}

/** The household finishes paying on this checkout page. The card is charged now. */
function householdPays(sessionId: string): string {
  const s = sessions.get(sessionId)!;
  const intentId = `pi_${sessionId}`;
  s.status = 'complete';
  s.payment_status = 'paid';
  s.payment_intent = intentId;
  s.url = null;
  intents.set(intentId, {
    id: intentId,
    latest_charge: { created: Math.floor(Date.now() / 1000), balance_transaction: { fee: 146 } },
  });
  return intentId;
}

// ── Firestore, with `arrayUnion` applied the way Firestore applies it ───────
let arrays: Record<string, Record<string, unknown[]>>;
function settleArrays() {
  for (const [path, doc] of Object.entries(docs)) {
    if (!doc) continue;
    for (const [field, value] of Object.entries(doc)) {
      const union = (value as { __arrayUnion?: unknown[] } | null)?.__arrayUnion;
      if (Array.isArray(union)) {
        const before = arrays[path]?.[field] ?? [];
        doc[field] = [...before, ...union.filter((v) => !before.includes(v))];
      }
      if (Array.isArray(doc[field])) (arrays[path] ??= {})[field] = doc[field];
    }
  }
}

function seed(invoice: Record<string, unknown>, rows: Array<Record<string, unknown>> = []) {
  docs = {
    'clients/kin-uid-1': { kinfolkIds: ['fam1'] },
    'families/fam1': { accountBalanceCents: 0 },
    [INVOICE]: { ...invoice },
  };
  rows.forEach((row, i) => {
    docs[`${INVOICE}/payments/row${i + 1}`] = { ...row };
  });
  arrays = {};
  settleArrays();
  const ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
  return ctx;
}

async function pay(urls: { successUrl: string; cancelUrl: string } = WEB): Promise<{
  ok?: { amountCents: number; sessionId: string; checkoutUrl: string };
  err?: any;
}> {
  const out = await payInvoiceHandler({ data: { invoiceId: 'inv1', ...urls }, auth: { uid: UID, token: {} } } as any).then(
    (ok) => ({ ok }),
    (err) => ({ err }),
  );
  settleArrays();
  return out;
}

/** Stripe delivers the paid event for this session, and the real webhook decides what the payment becomes. */
async function webhookLands(sessionId: string): Promise<Record<string, any>> {
  const s = sessions.get(sessionId)!;
  const eventId = `evt_${sessionId}`;
  hooks.events[eventId] = {
    id: eventId,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: s.id,
        payment_intent: s.payment_intent,
        payment_status: s.payment_status,
        amount_total: s.amount_total,
        metadata: s.metadata,
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
    { method: 'POST', headers: { 'stripe-signature': eventId }, rawBody: Buffer.from('{}') },
    res,
  );
  settleArrays();
  expect(code).toBe(200);
  return docs[`payments/${eventId}`] ?? {};
}

const BEING_RECORDED = {
  code: 'failed-precondition',
  message: PAYMENT_BEING_RECORDED,
  details: { code: PAYMENT_BEING_RECORDED_CODE },
};
const logged = (event: string) => hooks.log.mock.calls.filter((c) => c[0]?.event === event).map((c) => c[0]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  sessions = new Map();
  intents = new Map();
  hooks.enqueue.mockReset();
  hooks.enqueue.mockResolvedValue({ written: ['n1'], suppressed: [], unresolved: [] });
  hooks.audit.mockReset();
  hooks.audit.mockResolvedValue('audit-1');
  hooks.log.mockReset();
  hooks.createSession.mockReset();
  hooks.createSession.mockImplementation(async (params: any) => {
    const id = `cs_${sessions.size + 1}`;
    sessionAtStripe(id, {
      amount_total: params.line_items[0].price_data.unit_amount,
      success_url: params.success_url,
      cancel_url: params.cancel_url,
      metadata: params.metadata,
    });
    return { ...sessions.get(id)! };
  });
  hooks.retrieveSession.mockReset();
  hooks.retrieveSession.mockImplementation(async (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new Error('No such checkout.session');
    return { ...s };
  });
  hooks.retrieveIntent.mockReset();
  hooks.retrieveIntent.mockImplementation(async (id: string) => {
    const pi = intents.get(id);
    if (!pi) throw new Error('No such payment_intent');
    return pi;
  });
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#2437: a second window while the first payment is still being recorded', () => {
  it('two windows: the second gets the same checkout, and once it is paid Pay is refused until the webhook lands', async () => {
    seed(OPEN);

    const first = await pay();
    const second = await pay();
    // One checkout between the two windows, so one payment at most while it is open.
    expect(first.ok).toMatchObject({ sessionId: 'cs_1', amountCents: 4000 });
    expect(second.ok).toMatchObject({ sessionId: 'cs_1' });
    expect(hooks.createSession).toHaveBeenCalledTimes(1);

    householdPays('cs_1');
    const before = structuredClone(docs[INVOICE]);

    // The other window still reads owed, and Pay is pressed there.
    const again = await pay();

    expect(again.ok).toBeUndefined();
    expect(again.err).toMatchObject(BEING_RECORDED);
    expect(hooks.createSession).toHaveBeenCalledTimes(1);
    // Nothing is written by the refusal: the webhook alone records the payment.
    expect(docs[INVOICE]).toEqual(before);
    expect(docs['stripePayments/pi_cs_1']).toBeUndefined();
    expect(logged('portal.invoice.checkout.refused.recording')).toEqual([
      expect.objectContaining({
        function: 'payInvoice',
        uid: UID,
        extra: expect.objectContaining({ invoiceId: 'inv1', sessionId: 'cs_1', paymentIntentId: 'pi_cs_1' }),
      }),
    ]);

    // The webhook lands. The invoice is paid, once, and Pay answers as it does for any paid invoice.
    const row = await webhookLands('cs_1');
    expect(row.needsAdminDecision).toBeUndefined();
    expect(docs[`${INVOICE}/payments/stripe_pi_cs_1`]).toMatchObject({ amountCents: 4000 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid', amountDueCents: 0 });
    const afterPaid = await pay();
    expect(afterPaid.err).toMatchObject({ message: PAID_INVOICE_REFUSAL });
    expect(hooks.createSession).toHaveBeenCalledTimes(1);
  });

  it('cancel, then pay on the page left open, then come back by hand: refused, however long ago the checkout was opened', async () => {
    seed(OPEN);
    await pay();
    // The household backs out of Stripe, and three hours later pays on that
    // same page, which was still open in another tab.
    vi.setSystemTime(NOW + 3 * 3600_000);
    householdPays('cs_1');
    vi.setSystemTime(NOW + 3 * 3600_000 + 20_000);

    const again = await pay();

    // Measured from when the card was charged, not from when the checkout was opened.
    expect(again.err).toMatchObject(BEING_RECORDED);
    expect(hooks.createSession).toHaveBeenCalledTimes(1);
  });

  it('a checkout from another app with its own return address: paying one stops Pay handing back the other', async () => {
    seed(OPEN);
    await pay(WEB);
    const android = await pay(OLD_ANDROID);
    // Different return addresses, so the second app got a checkout of its own.
    expect(android.ok).toMatchObject({ sessionId: 'cs_2' });
    expect(docs[INVOICE]).toMatchObject({ pendingCheckoutSessionId: 'cs_2', openCheckoutSessionIds: ['cs_1', 'cs_2'] });

    householdPays('cs_1');

    // cs_2 is still open and would have been handed straight back.
    const again = await pay(OLD_ANDROID);
    expect(again.ok).toBeUndefined();
    expect(again.err).toMatchObject(BEING_RECORDED);
    expect(hooks.createSession).toHaveBeenCalledTimes(2);
  });
});

describe('#2437: once the webhook has recorded the payment, Pay works for what is still owed', () => {
  it('a payment put on the invoice that leaves a balance: refused before it lands, a new checkout for the rest after', async () => {
    seed(OPEN);
    await pay();
    // The office adds to the bill after the checkout page was opened.
    Object.assign(docs[INVOICE]!, { total: 60, totalCents: 6000, amountDue: 60, amountDueCents: 6000 });
    householdPays('cs_1');

    expect((await pay()).err).toMatchObject(BEING_RECORDED);

    await webhookLands('cs_1');
    expect(docs['stripePayments/pi_cs_1']).toBeDefined();
    expect(docs[`${INVOICE}/payments/stripe_pi_cs_1`]).toMatchObject({ amountCents: 4000 });
    expect(docs[INVOICE]).toMatchObject({ amountDueCents: 2000 });

    const rest = await pay();
    expect(rest.err).toBeUndefined();
    expect(rest.ok).toMatchObject({ sessionId: 'cs_2', amountCents: 2000 });
    expect(hooks.createSession).toHaveBeenCalledTimes(2);
  });

  it('a payment the webhook held for the owner: refused before it lands, a new checkout for the balance after', async () => {
    // The bill was paid by card once and its balance came back. A checkout
    // page from before that payment is still open at Stripe.
    seed(
      {
        ...OPEN,
        total: 80,
        totalCents: 8000,
        paidCents: 4000,
        stripeCheckoutRound: 1,
        stripeSettledPaymentIntentId: 'pi_earlier',
        openCheckoutSessionIds: ['cs_old'],
      },
      [{ amountCents: 4000 }],
    );
    sessionAtStripe('cs_old');
    householdPays('cs_old');

    expect((await pay()).err).toMatchObject(BEING_RECORDED);
    expect(hooks.createSession).not.toHaveBeenCalled();

    // The webhook keeps it off the invoice (a checkout from a round that has closed) and claims the payment.
    const row = await webhookLands('cs_old');
    expect(row).toMatchObject({ needsAdminDecision: true, appliedToInvoice: false, duplicateCheckoutReason: 'stale-round' });
    expect(docs['stripePayments/pi_cs_old']).toMatchObject({ appliedOutcome: 'DUPLICATE_INVOICE_CHECKOUT' });
    expect(docs[INVOICE]).toMatchObject({ amountDueCents: 4000, status: 'open' });

    const rest = await pay();
    expect(rest.err).toBeUndefined();
    expect(rest.ok).toMatchObject({ amountCents: 4000 });
    expect(hooks.createSession).toHaveBeenCalledTimes(1);
    expect(hooks.createSession.mock.calls[0]![0].metadata.checkoutRound).toBe('1');
  });
});

describe('#2437: a payment that never lands does not hold Pay for ever', () => {
  it('refused inside the window, and the ordinary checkout after it, with a warning for the operator', async () => {
    seed(OPEN);
    await pay();
    householdPays('cs_1');

    vi.setSystemTime(NOW + PAYMENT_RECORDING_WINDOW_MS - 1_000);
    expect((await pay()).err).toMatchObject(BEING_RECORDED);
    expect(logged('portal.invoice.checkout.recording.overdue')).toEqual([]);

    vi.setSystemTime(NOW + PAYMENT_RECORDING_WINDOW_MS);
    const late = await pay();
    expect(late.err).toBeUndefined();
    expect(late.ok).toMatchObject({ sessionId: 'cs_2', amountCents: 4000 });
    expect(logged('portal.invoice.checkout.recording.overdue')).toEqual([
      expect.objectContaining({
        severity: 'warn',
        extra: expect.objectContaining({ invoiceId: 'inv1', sessionId: 'cs_1', paymentIntentId: 'pi_cs_1' }),
      }),
    ]);

    // The webhook is still the truth: when the first payment does arrive it goes on the invoice.
    await webhookLands('cs_1');
    expect(docs[`${INVOICE}/payments/stripe_pi_cs_1`]).toMatchObject({ amountCents: 4000 });
    expect(docs[INVOICE]).toMatchObject({ status: 'paid' });
  });

  it('a payment whose time cannot be read holds nothing', async () => {
    seed(OPEN);
    await pay();
    householdPays('cs_1');
    hooks.retrieveIntent.mockRejectedValue(new Error('Stripe is not answering'));

    const out = await pay();

    expect(out.err).toBeUndefined();
    expect(out.ok).toMatchObject({ sessionId: 'cs_2' });
    expect(logged('portal.invoice.checkout.recording.unreadable')).toHaveLength(1);
  });

  it('a payment with no charge on it holds nothing', async () => {
    seed(OPEN);
    await pay();
    const intentId = householdPays('cs_1');
    intents.set(intentId, { id: intentId } as any);

    const out = await pay();

    expect(out.ok).toMatchObject({ sessionId: 'cs_2' });
    expect(logged('portal.invoice.checkout.recording.unreadable')).toHaveLength(1);
  });
});

describe('#2437: every other stored checkout still opens a new one', () => {
  it.each<[string, Partial<FakeSession>]>([
    ['expired', { status: 'expired', url: null }],
    ['finished with the money not collected', { status: 'complete', payment_status: 'unpaid', url: null }],
    ['finished and paid for another invoice', { status: 'complete', payment_status: 'paid', payment_intent: 'pi_other', url: null, metadata: { invoiceId: 'inv9' } }],
    ['finished and paid with no payment named', { status: 'complete', payment_status: 'paid', payment_intent: null, url: null }],
  ])('a stored checkout that %s', async (_label, over) => {
    seed({ ...OPEN, pendingCheckoutSessionId: 'cs_old', openCheckoutSessionIds: ['cs_old'] });
    sessionAtStripe('cs_old', over);

    const out = await pay();

    expect(out.err).toBeUndefined();
    expect(out.ok).toMatchObject({ amountCents: 4000 });
    expect(hooks.createSession).toHaveBeenCalledTimes(1);
    // No payment was looked up for it.
    expect(hooks.retrieveIntent).not.toHaveBeenCalled();
  });

  it('a stored checkout Stripe cannot find', async () => {
    seed({ ...OPEN, pendingCheckoutSessionId: 'cs_gone', openCheckoutSessionIds: ['cs_gone'] });

    const out = await pay();

    expect(out.ok).toMatchObject({ amountCents: 4000 });
    expect(hooks.createSession).toHaveBeenCalledTimes(1);
  });

  it('an ordinary open invoice with its checkout still open is handed that checkout, with one read of it', async () => {
    seed(OPEN);
    await pay();
    hooks.retrieveSession.mockClear();

    const out = await pay();

    expect(out.ok).toMatchObject({ sessionId: 'cs_1' });
    expect(hooks.retrieveSession).toHaveBeenCalledTimes(1);
    expect(hooks.retrieveSession).toHaveBeenCalledWith('cs_1');
    expect(hooks.retrieveIntent).not.toHaveBeenCalled();
  });

  it('an invoice with no stored checkout reads nothing from Stripe', async () => {
    seed(OPEN);

    const out = await pay();

    expect(out.ok).toMatchObject({ sessionId: 'cs_1' });
    expect(hooks.retrieveSession).not.toHaveBeenCalled();
    expect(hooks.retrieveIntent).not.toHaveBeenCalled();
  });
});

describe('#2437: a portal build from before this change is given the sentence', () => {
  it('the refusal is a plain failed-precondition whose own message is the sentence', async () => {
    seed(OPEN);
    await pay();
    householdPays('cs_1');

    const { err } = await pay();

    // Both portals print a refusal's message as it arrives (`errorLine` on the
    // web, `t.message` in the Android app). `internal` is the one code whose
    // message a client never sees, so the code matters as much as the words.
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toBe('A payment on this invoice is still being recorded. Check again in a minute.');
    expect(err.message).not.toMatch(/[—_{}]|stripe|webhook|session/i);
  });
});

describe('#2437: the rule on its own', () => {
  it('reads the pending checkout first, then the rest newest first, without the closed ones', () => {
    expect(checkoutSessionIdsToRead({})).toEqual([]);
    expect(checkoutSessionIdsToRead(null)).toEqual([]);
    expect(checkoutSessionIdsToRead({ pendingCheckoutSessionId: 'cs_p' })).toEqual(['cs_p']);
    expect(
      checkoutSessionIdsToRead({
        pendingCheckoutSessionId: 'cs_3',
        openCheckoutSessionIds: ['cs_1', 'cs_2', 'cs_3', '', 7],
        closedCheckoutSessionIds: ['cs_1'],
      }),
    ).toEqual(['cs_3', 'cs_2']);
    // No pending id (the webhook cleared it): the stored list alone.
    expect(checkoutSessionIdsToRead({ openCheckoutSessionIds: ['cs_1', 'cs_2'] })).toEqual(['cs_2', 'cs_1']);
  });

  it('reads a bounded number of checkouts, the newest ones', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `cs_${i + 1}`);
    const read = checkoutSessionIdsToRead({ pendingCheckoutSessionId: 'cs_12', openCheckoutSessionIds: ids });
    expect(read).toHaveLength(MAX_CHECKOUT_SESSIONS_READ);
    expect(read).toEqual(['cs_12', 'cs_11', 'cs_10', 'cs_9']);
  });

  it('a finished checkout is complete, paid, for this invoice, and names its payment', () => {
    const done = { id: 'cs_1', status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', metadata: { invoiceId: 'inv1' } };
    expect(finishedCheckoutOf(done, 'inv1')).toEqual({ sessionId: 'cs_1', paymentIntentId: 'pi_1' });
    expect(finishedCheckoutOf({ ...done, payment_intent: { id: 'pi_1' } }, 'inv1')).toEqual({ sessionId: 'cs_1', paymentIntentId: 'pi_1' });
    expect(finishedCheckoutOf({ ...done, status: 'open' }, 'inv1')).toBeNull();
    expect(finishedCheckoutOf({ ...done, status: 'expired' }, 'inv1')).toBeNull();
    expect(finishedCheckoutOf({ ...done, payment_status: 'unpaid' }, 'inv1')).toBeNull();
    expect(finishedCheckoutOf({ ...done, payment_status: undefined }, 'inv1')).toBeNull();
    expect(finishedCheckoutOf({ ...done, payment_intent: null }, 'inv1')).toBeNull();
    expect(finishedCheckoutOf(done, 'inv2')).toBeNull();
    expect(finishedCheckoutOf({ ...done, metadata: null }, 'inv1')).toBeNull();
    expect(finishedCheckoutOf(null, 'inv1')).toBeNull();
    expect(finishedCheckoutOf('cs_1', 'inv1')).toBeNull();
  });

  it('the payment time is the charge time, in milliseconds, or nothing', () => {
    expect(chargeTimeMsOf({ latest_charge: { created: 1_763_000_000 } })).toBe(1_763_000_000_000);
    expect(chargeTimeMsOf({ latest_charge: 'ch_1' })).toBeNull();
    expect(chargeTimeMsOf({ latest_charge: null })).toBeNull();
    expect(chargeTimeMsOf({ created: 1_763_000_000 })).toBeNull();
    expect(chargeTimeMsOf({ latest_charge: { created: 0 } })).toBeNull();
    expect(chargeTimeMsOf(null)).toBeNull();
  });

  it('the hold ends at the window, measured from the charge', () => {
    expect(holdsPay(NOW, NOW)).toBe(true);
    expect(holdsPay(NOW, NOW + PAYMENT_RECORDING_WINDOW_MS - 1)).toBe(true);
    expect(holdsPay(NOW, NOW + PAYMENT_RECORDING_WINDOW_MS)).toBe(false);
    expect(PAYMENT_RECORDING_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});
