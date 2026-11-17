import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
import { installOptimisticTransactions } from './_helpers/optimisticTransaction';

/**
 * #2358: A CARD PAYMENT ON A CANCELLED INVOICE IS HELD FOR THE OWNER.
 *
 * A checkout page opened while the invoice was owed can still be paid on after
 * the invoice is cancelled. The card is charged before the webhook hears of it,
 * and there are no refunds, so the payment is recorded. What it must not do is
 * what it did: flip the invoice to `status: 'paid'` (with `invoiceStatus` left
 * at `cancelled`) and tell the household their payment was applied.
 *
 * The webhook, `listUnappliedPayments` and `resolveUnappliedPayment` run here
 * for real against one in-memory Firestore with optimistic transactions, the
 * same harness as `cardPaymentOrder.test.ts`. Only Stripe is stubbed.
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
import { listUnappliedPaymentsHandler } from '../src/admin/listUnappliedPayments';
import { resolveUnappliedPaymentHandler } from '../src/admin/resolveUnappliedPayment';
import { duplicateCheckoutReason, unappliedReasonLabel } from '../src/lib/invoiceCheckoutDedupe';

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
/** Cancelled with its balance still stated: cancelling does not zero one. */
const CANCELLED = { ...OPEN, status: 'cancelled', invoiceStatus: 'cancelled' };
const META = { familyId: 'fam1', kinfolkId: 'fam1', invoiceId: 'inv1', uid: 'kin-uid-1', checkoutRound: '0' };
const T0 = 1_763_000_000;
const at = (n: number) => T0 + n;

/** The two events one successful card payment delivers. Signatures `session-<n>` and `intent-<n>`. */
function paid(n: number, cents: number, createdAt: number) {
  hooks.events[`session-${n}`] = {
    id: `evt_cs_${n}`,
    type: 'checkout.session.completed',
    created: at(createdAt),
    data: {
      object: { id: `cs_${n}`, payment_intent: `pi_${n}`, payment_status: 'paid', amount_total: cents, metadata: META },
    },
  };
  hooks.events[`intent-${n}`] = {
    id: `evt_pi_${n}`,
    type: 'payment_intent.succeeded',
    created: at(createdAt),
    data: { object: { id: `pi_${n}`, amount_received: cents, metadata: META } },
  };
}

/** A declined charge on PaymentIntent n. Signature `declined-<n>`. */
function declined(n: number, createdAt: number) {
  hooks.events[`declined-${n}`] = {
    id: `evt_fail_${n}`,
    type: 'payment_intent.payment_failed',
    created: at(createdAt),
    data: {
      object: {
        id: `pi_${n}`,
        amount: 4000,
        amount_received: 0,
        last_payment_error: { code: 'card_declined' },
        metadata: META,
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
  for (const k of Object.keys(hooks.events)) delete hooks.events[k];
  docs = {
    [INVOICE]: { ...CANCELLED },
    'invoices/inv2': { kinfolkId: 'fam1', invoiceNumber: '1030', status: 'open', totalCents: 2500, amountDueCents: 2500 },
    'families/fam1': { accountBalanceCents: 0 },
  };
  const ctx = buildDbMock({ docs, writeThrough: true });
  hooks.db.current = ctx.db;
  installOptimisticTransactions(ctx.db, docs);
});

const invoiceRows = () => Object.keys(docs).filter((p) => p.startsWith(`${INVOICE}/payments/`) && docs[p] != null);
const ledgerRows = () => Object.keys(docs).filter((p) => /^payments\/[^/]+$/.test(p) && docs[p] != null);
const notices = (key: string) => hooks.enqueue.mock.calls.filter((c) => c[0]?.key === key);
const audits = (event: string) => hooks.audit.mock.calls.filter((c) => c[0]?.event === event);
const outcome = (eventId: string) => docs[`stripeEvents/${eventId}`]?.appliedOutcome;

/** The invoice reads exactly as it did before the card payment: cancelled, no money on it. */
function expectStillCancelled(before: Record<string, any> = CANCELLED) {
  const inv = docs[INVOICE]!;
  expect(inv.status).toBe(before.status);
  expect(inv.invoiceStatus).toBe(before.invoiceStatus);
  expect(inv.amountDue).toBe(before.amountDue);
  expect(inv.amountDueCents).toBe(before.amountDueCents);
  expect(inv.total).toBe(before.total);
  for (const key of [
    'paymentStatus',
    'paidCents',
    'paidAt',
    'paymentMethod',
    'paymentReference',
    'cardApplyFallback',
    'stripeSettledPaymentIntentId',
    'stripeCheckoutRound',
    'paymentAppliedNoticeOwner',
  ]) {
    expect(inv[key], key).toBeUndefined();
  }
  expect(invoiceRows()).toEqual([]);
}

/** One held payment, on the ledger row named, and nobody told it was applied. */
function expectHeldOnce(ledgerEventId: string, n = 1) {
  expect(ledgerRows()).toEqual([`payments/${ledgerEventId}`]);
  const row = docs[`payments/${ledgerEventId}`]!;
  expect(row).toMatchObject({
    kinfolkId: 'fam1',
    invoiceId: 'inv1',
    // The whole charge, gross, with Stripe's fee beside it. Nothing is netted.
    amountCents: 4000,
    amountResolved: true,
    feeCents: 146,
    feeResolved: true,
    paymentMethod: 'stripe',
    referenceNumber: `pi_${n}`,
    appliedToInvoice: false,
    appliedTo: 'unapplied',
    needsAdminDecision: true,
    creditedToAccountCents: 0,
    duplicateCheckoutReason: 'invoice-cancelled',
  });
  // Nothing was applied, so there is no applied part and no tip to split out.
  for (const key of ['appliedInvoiceId', 'appliedCents', 'tipCents', 'proceedsCents', 'invoicePaymentId', 'cardApplyFallback']) {
    expect(row[key], key).toBeUndefined();
  }
  expect(docs[`stripePayments/pi_${n}`]).toMatchObject({ invoiceId: 'inv1', appliedEventId: ledgerEventId });
  expect(docs[`stripeEvents/${ledgerEventId}`]).toMatchObject({
    appliedOutcome: 'SKIPPED_DUPLICATE_INVOICE',
    duplicateReason: 'invoice-cancelled',
    unappliedCents: 4000,
    followupTracked: true,
  });
  // The household hears nothing: not "applied", not "failed".
  expect(notices('invoice.payment.applied')).toHaveLength(0);
  expect(notices('invoice.charge.failed')).toHaveLength(0);
  expect(audits('BILLING_INVOICE_PAID')).toHaveLength(0);
  // The owner is told once, and only the business.
  expect(notices('invoice.payment.unapplied')).toHaveLength(1);
  expect(notices('invoice.payment.unapplied')[0]![0]).toMatchObject({
    recipientUid: '',
    data: {
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      stripeEventId: ledgerEventId,
      unappliedAmount: '$40.00',
      unappliedReason: 'the invoice was cancelled',
    },
  });
  expect(audits('BILLING_PAYMENT_UNAPPLIED')).toHaveLength(1);
  expect(audits('BILLING_PAYMENT_UNAPPLIED')[0]![0]).toMatchObject({
    severity: 'critical',
    familyId: 'fam1',
    payload: { invoiceId: 'inv1', paymentId: ledgerEventId, unappliedCents: 4000, duplicateReason: 'invoice-cancelled' },
  });
  // No credit by itself, and the fallback landing was not taken.
  expect(docs['families/fam1']!.accountBalanceCents).toBe(0);
  expect(hooks.log.mock.calls.filter((c) => c[0]?.event === 'stripe.cardApply.fallback')).toHaveLength(0);
}

describe('#2358: a card payment from an old checkout page on a cancelled invoice', () => {
  it('is held for the owner, and the invoice stays cancelled', async () => {
    paid(1, 4000, 1);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectHeldOnce('evt_cs_1');
    expect(outcome('evt_pi_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expectStillCancelled();
    expect(docs[INVOICE]!.unappliedPaymentIds).toEqual({ __arrayUnion: ['evt_cs_1'] });
  });

  it('the same when the PaymentIntent event is heard first', async () => {
    paid(1, 4000, 1);

    expect(await deliver('intent-1')).toBe(200);
    expect(await deliver('session-1')).toBe(200);

    expectHeldOnce('evt_pi_1');
    expect(outcome('evt_cs_1')).toBe('SKIPPED_DUPLICATE_PAYMENT');
    expectStillCancelled();
  });

  it('both events, each sent twice: one held payment, one notice to the owner', async () => {
    paid(1, 4000, 1);

    for (const sig of ['session-1', 'session-1', 'intent-1', 'intent-1', 'session-1']) {
      expect(await deliver(sig)).toBe(200);
    }

    expectHeldOnce('evt_cs_1');
    expectStillCancelled();
  });

  it('the notice to the owner failing answers 500, and the retry sends it without a second row', async () => {
    paid(1, 4000, 1);
    hooks.enqueue.mockRejectedValueOnce(new Error('roster unreachable'));

    expect(await deliver('session-1')).toBe(500);
    expect(ledgerRows()).toEqual(['payments/evt_cs_1']);
    expect(docs['stripeEvents/evt_cs_1']!.noticeSentAt).toBeUndefined();
    hooks.enqueue.mockClear();

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(docs['stripeEvents/evt_cs_1']!.noticeSentAt).toBeTruthy();
    expectHeldOnce('evt_cs_1');
    expectStillCancelled();
  });

  it('the invoice being cancelled while the payment is deciding: held, not applied', async () => {
    docs[INVOICE] = { ...OPEN };
    paid(1, 4000, 1);
    let fired = false;
    installOptimisticTransactions(hooks.db.current as any, docs, {
      onRead: (path) => {
        if (fired || path !== INVOICE) return;
        fired = true;
        docs[INVOICE] = { ...docs[INVOICE]!, status: 'cancelled', invoiceStatus: 'cancelled' };
      },
    });

    expect(await deliver('session-1')).toBe(200);

    expect(fired).toBe(true);
    expectHeldOnce('evt_cs_1');
    expectStillCancelled();
  });

  const shapes: Array<[string, Record<string, any>]> = [
    ['with its balance zeroed', { ...CANCELLED, amountDue: 0, amountDueCents: 0 }],
    ['that states no balance at all', { kinfolkId: 'fam1', invoiceNumber: '1029', status: 'cancelled', total: 40, totalCents: 4000 }],
    ['labelled in the legacy field only', { ...OPEN, status: undefined, invoiceStatus: 'cancelled' }],
    ['spelled with capitals and spaces', { ...OPEN, status: ' Cancelled ', invoiceStatus: 'cancelled' }],
    [
      'that is a withdrawn quote',
      { ...CANCELLED, quoteWithdrawnAt: '__TS__', quoteWithdrawnBy: 'owner1', quoteSentAt: '__TS__' },
    ],
    ['on a checkout round that has since closed', { ...CANCELLED, stripeCheckoutRound: 3, stripeSettledPaymentIntentId: 'pi_old' }],
  ];
  it.each(shapes)('a cancelled invoice %s: held as cancelled', async (_name, shape) => {
    const before = Object.fromEntries(Object.entries(shape).filter(([, v]) => v !== undefined));
    docs[INVOICE] = { ...before };
    paid(1, 4000, 1);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(docs['payments/evt_cs_1']).toMatchObject({
      amountCents: 4000,
      feeCents: 146,
      appliedToInvoice: false,
      needsAdminDecision: true,
      duplicateCheckoutReason: 'invoice-cancelled',
    });
    expect(ledgerRows()).toEqual(['payments/evt_cs_1']);
    // Every field the invoice had is as it was. The only additions are the
    // record that a payment came in.
    for (const [key, value] of Object.entries(before)) expect(docs[INVOICE]![key], key).toEqual(value);
    expect(docs[INVOICE]!.paidCents).toBeUndefined();
    expect(docs[INVOICE]!.paymentStatus).toBeUndefined();
    expect(docs[INVOICE]!.cardApplyFallback).toBeUndefined();
    expect(invoiceRows()).toEqual([]);
    expect(notices('invoice.payment.applied')).toHaveLength(0);
    expect(notices('invoice.payment.unapplied')).toHaveLength(1);
    expect(notices('invoice.payment.unapplied')[0]![0].data.unappliedReason).toBe('the invoice was cancelled');
  });
});

describe('#2358: a decline from the same checkout, heard after the held payment', () => {
  it('tells the household nothing, and moves nothing', async () => {
    paid(1, 4000, 1);
    declined(1, 5);

    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('declined-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expect(outcome('evt_fail_1')).toBe('FAILED_AFTER_PAYMENT');
    expect(audits('BILLING_INVOICE_FAILED')).toHaveLength(0);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')).toHaveLength(1);
    expect(audits('BILLING_CARD_DECLINED_AFTER_PAYMENT')[0]![0].description).toBe(
      'A card was declined on invoice 1029, and the payment from the same checkout went through. No notice was sent to the household.',
    );
    expectHeldOnce('evt_cs_1');
    expectStillCancelled();
    // The decline did not stamp the invoice either.
    expect(docs[INVOICE]!.lastStripeEventAtMs).toBeUndefined();
  });

  it('a decline heard BEFORE the payment from the same checkout does not stop the payment being held', async () => {
    declined(1, 1);
    paid(1, 4000, 5);

    expect(await deliver('declined-1')).toBe(200);
    hooks.enqueue.mockClear();
    hooks.audit.mockClear();
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);

    expectHeldOnce('evt_cs_1');
    expect(docs[INVOICE]).toMatchObject({ status: 'cancelled', invoiceStatus: 'cancelled', amountDueCents: 4000 });
    expect(invoiceRows()).toEqual([]);
  });
});

describe('#2358: the owner sees the held payment and decides', () => {
  async function held() {
    paid(1, 4000, 1);
    expect(await deliver('session-1')).toBe(200);
    expect(await deliver('intent-1')).toBe(200);
    hooks.enqueue.mockClear();
    hooks.audit.mockClear();
  }

  it('the list names the invoice, the amount, the fee and why, and never offers the cancelled invoice', async () => {
    await held();

    const res = await listUnappliedPaymentsHandler(ownerReq({ kinfolkId: 'fam1' }));

    expect(res.payments).toHaveLength(1);
    expect(res.payments[0]).toMatchObject({
      paymentId: 'evt_cs_1',
      kinfolkId: 'fam1',
      invoiceId: 'inv1',
      invoiceNumber: '1029',
      amountCents: 4000,
      amountResolved: true,
      feeCents: 146,
      reason: 'the invoice was cancelled',
      referenceNumber: 'pi_1',
    });
    expect(res.openInvoices.map((i) => i.invoiceId)).toEqual(['inv2']);
  });

  it('all of it to account credit, because the owner chose that: the balance moves by her amount only', async () => {
    await held();

    const res = await resolveUnappliedPaymentHandler(
      ownerReq({
        paymentId: 'evt_cs_1',
        creditCents: 4000,
        creditReason: 'Paid by card on invoice 1029 after it was cancelled',
        applyInvoiceId: '',
        applyCents: 0,
        idempotencyKey: 'upd_1790000000000_abc123',
      }),
    );

    expect(res).toMatchObject({
      ok: true,
      paymentCents: 4000,
      creditedCents: 4000,
      appliedCents: 0,
      keptCents: 0,
      newAccountBalanceCents: 4000,
      replayed: false,
    });
    expect(docs['families/fam1']!.accountBalanceCents).toBe(4000);
    expect(docs['payments/evt_cs_1']).toMatchObject({
      needsAdminDecision: false,
      appliedTo: 'adminDecision',
      appliedToInvoice: false,
      creditedToAccountCents: 4000,
      // The charge and its fee are as recorded: the credit is the gross amount she typed.
      amountCents: 4000,
      feeCents: 146,
    });
    expectStillCancelled();
    expect(notices('invoice.payment.applied')).toHaveLength(0);
    // Decided: it is off the list.
    const after = await listUnappliedPaymentsHandler(ownerReq({ kinfolkId: 'fam1' }));
    expect(after.payments).toEqual([]);

    // The same save sent again answers the stored decision and credits nothing more.
    const replay = await resolveUnappliedPaymentHandler(
      ownerReq({
        paymentId: 'evt_cs_1',
        creditCents: 4000,
        creditReason: 'Paid by card on invoice 1029 after it was cancelled',
        applyInvoiceId: '',
        applyCents: 0,
        idempotencyKey: 'upd_1790000000000_abc123',
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(docs['families/fam1']!.accountBalanceCents).toBe(4000);
  });

  it('part to credit, part to another open invoice, the rest kept', async () => {
    await held();

    const res = await resolveUnappliedPaymentHandler(
      ownerReq({
        paymentId: 'evt_cs_1',
        creditCents: 1000,
        creditReason: 'Goodwill',
        applyInvoiceId: 'inv2',
        applyCents: 2500,
        idempotencyKey: 'upd_1790000000000_abc124',
      }),
    );

    expect(res).toMatchObject({ creditedCents: 1000, appliedCents: 2500, keptCents: 500, appliedInvoiceId: 'inv2' });
    expect(docs['families/fam1']!.accountBalanceCents).toBe(1000);
    expect(docs['invoices/inv2']).toMatchObject({ amountDueCents: 0 });
    expectStillCancelled();
  });

  it('it cannot be put back on the cancelled invoice', async () => {
    await held();

    await expect(
      resolveUnappliedPaymentHandler(
        ownerReq({
          paymentId: 'evt_cs_1',
          creditCents: 0,
          creditReason: '',
          applyInvoiceId: 'inv1',
          applyCents: 4000,
          idempotencyKey: 'upd_1790000000000_abc125',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'This invoice is cancelled, so a payment cannot be recorded against it.',
      details: { code: 'apply_invoice_not_payable' },
    });

    expect(docs['payments/evt_cs_1']).toMatchObject({ needsAdminDecision: true, appliedTo: 'unapplied' });
    expectStillCancelled();
    expect(docs['families/fam1']!.accountBalanceCents).toBe(0);
  });

  it('an invoice cancelled in the legacy field only is not offered, and takes none of it back', async () => {
    // The webhook holds a payment on this shape, so the list and the decision
    // have to read cancelled the same way. `planApply` reads `status` alone.
    const legacy: Record<string, any> = { ...OPEN, invoiceStatus: 'cancelled' };
    delete legacy.status;
    docs[INVOICE] = { ...legacy };
    await held();
    expect(docs['payments/evt_cs_1']).toMatchObject({
      needsAdminDecision: true,
      duplicateCheckoutReason: 'invoice-cancelled',
    });

    const res = await listUnappliedPaymentsHandler(ownerReq({ kinfolkId: 'fam1' }));
    expect(res.openInvoices.map((i) => i.invoiceId)).toEqual(['inv2']);

    await expect(
      resolveUnappliedPaymentHandler(
        ownerReq({
          paymentId: 'evt_cs_1',
          creditCents: 0,
          creditReason: '',
          applyInvoiceId: 'inv1',
          applyCents: 4000,
          idempotencyKey: 'upd_1790000000000_abc127',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'This invoice is cancelled, so a payment cannot be recorded against it.',
      details: { code: 'apply_invoice_not_payable' },
    });

    expect(docs['payments/evt_cs_1']).toMatchObject({ needsAdminDecision: true, appliedTo: 'unapplied' });
    for (const [key, value] of Object.entries(legacy)) expect(docs[INVOICE]![key], key).toEqual(value);
    for (const key of ['status', 'paymentStatus', 'paidCents', 'paidAt']) expect(docs[INVOICE]![key], key).toBeUndefined();
    expect(invoiceRows()).toEqual([]);
    expect(docs['families/fam1']!.accountBalanceCents).toBe(0);
  });

  it('left undecided, nothing is credited and nothing is told to the household', async () => {
    await held();

    expect(docs['families/fam1']!.accountBalanceCents).toBe(0);
    expect(docs['payments/evt_cs_1']).toMatchObject({ needsAdminDecision: true, creditedToAccountCents: 0 });
    expect(hooks.enqueue).not.toHaveBeenCalled();
  });
});

describe('#2358: the decision (duplicateCheckoutReason)', () => {
  const owing = { round: 0, settledPaymentIntentId: undefined, amountDueCents: 4000, amountDue: 40 };
  const ask = (invoice: Record<string, unknown>, eventRound: number | null = 0) =>
    duplicateCheckoutReason({ invoice: { ...owing, ...invoice }, paymentIntentId: 'pi_1', eventRound });

  it('a cancelled invoice takes no payment, whatever its balance says', () => {
    expect(ask({ status: 'cancelled' })).toBe('invoice-cancelled');
    expect(ask({ status: 'cancelled', amountDueCents: 0, amountDue: 0 })).toBe('invoice-cancelled');
    expect(ask({ status: 'cancelled', amountDueCents: undefined, amountDue: undefined })).toBe('invoice-cancelled');
    expect(ask({ invoiceStatus: 'cancelled' })).toBe('invoice-cancelled');
    expect(ask({ status: 'Cancelled' })).toBe('invoice-cancelled');
  });

  it('cancelled is the reason given even when the round is stale or another payment is named', () => {
    expect(ask({ status: 'cancelled', round: 2 }, 0)).toBe('invoice-cancelled');
    expect(ask({ status: 'cancelled', amountDueCents: 0, settledPaymentIntentId: 'pi_other' })).toBe('invoice-cancelled');
  });

  it('`status` wins over the legacy field, as it does for payInvoice', () => {
    expect(ask({ status: 'open', invoiceStatus: 'cancelled' })).toBeNull();
    expect(ask({ status: 'paid', invoiceStatus: 'cancelled' })).toBe('invoice-marked-paid');
  });

  it('an invoice that is not cancelled is decided as before', () => {
    expect(ask({ status: 'open' })).toBeNull();
    expect(ask({})).toBeNull();
    expect(ask({ status: 'open', round: 1 }, 0)).toBe('stale-round');
    expect(ask({ status: 'open', amountDueCents: 0 })).toBe('invoice-not-owed');
    expect(ask({ status: 'paid' })).toBe('invoice-marked-paid');
  });

  it('the sentence reads after each lead-in the owner sees', () => {
    const reason = unappliedReasonLabel('invoice-cancelled');
    expect(reason).toBe('the invoice was cancelled');
    // The three clients' row, the email and the SMS.
    expect(`Not applied because ${reason}.`).toBe('Not applied because the invoice was cancelled.');
    expect(`A card payment of $40.00 came in for invoice 1029, but ${reason}.`).toBe(
      'A card payment of $40.00 came in for invoice 1029, but the invoice was cancelled.',
    );
  });
});
