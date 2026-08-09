import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';

// The Stripe client's `paymentIntents.retrieve` — the ONE call the fee
// resolution makes, mocked per-test via `.mockResolvedValue` /
// `.mockRejectedValue`. `vi.hoisted` so the factory below (itself hoisted by
// vi.mock) can close over it.
//
// `charges.retrieve` is the dispute path's THIRD attribution route and it is a
// separate handle on purpose: a suite that mocked only `paymentIntents` would
// let `charges.retrieve` throw a TypeError inside the resolver's catch and go
// green with the charge route never working: the same false assurance the
// hand-injected metadata fixtures below are annotated for.
const stripeMock = vi.hoisted(() => ({ paymentIntentsRetrieve: vi.fn(), chargesRetrieve: vi.fn() }));

// Stripe verifier stub. `good` → a paid event carrying familyId metadata;
// `good-kinfolk` → paid event carrying only the legacy kinfolkId metadata.
vi.mock('../src/lib/stripe', () => ({
  getStripe: async () => ({
    paymentIntents: { retrieve: stripeMock.paymentIntentsRetrieve },
    charges: { retrieve: stripeMock.chargesRetrieve },
  }),
  verifyStripeWebhook: (_body: Buffer, sig: string) => {
    if (sig === 'good') {
      return {
        id: 'evt_1',
        type: 'invoice.paid',
        created: 1000,
        data: { object: { id: 'cs_1', payment_intent: 'pi_1', metadata: { familyId: 'f1', invoiceId: 'i1' } } },
      };
    }
    if (sig === 'good-kinfolk') {
      return {
        id: 'evt_2',
        type: 'payment_intent.succeeded',
        created: 1000,
        data: { object: { id: 'pi_2', metadata: { kinfolkId: 'f2', invoiceId: 'i2' } } },
      };
    }
    // NOTE-57: event carries the authoritative amount_paid; local invoice has none.
    if (sig === 'event-amount') {
      return {
        id: 'evt_3',
        type: 'invoice.paid',
        created: 1000,
        data: { object: { id: 'in_3', payment_intent: 'pi_3', amount_paid: 4200, metadata: { familyId: 'f3', invoiceId: 'i3' } } },
      };
    }
    // NOTE-57: neither the event nor the invoice yields an amount -> must flag,
    // not silently store null.
    if (sig === 'no-amount') {
      return {
        id: 'evt_4',
        type: 'payment_intent.succeeded',
        created: 1000,
        data: { object: { id: 'pi_4', metadata: { familyId: 'f4', invoiceId: 'i4' } } },
      };
    }
    // U6: fee capture. Both carry a resolvable payment_intent id (pi_5 / pi_6)
    // so the fee lookup has something to retrieve.
    if (sig === 'fee-ok') {
      return {
        id: 'evt_5',
        type: 'invoice.paid',
        created: 1000,
        data: { object: { id: 'in_5', payment_intent: 'pi_5', amount_paid: 13750, metadata: { familyId: 'f5', invoiceId: 'i5' } } },
      };
    }
    if (sig === 'fee-fail') {
      return {
        id: 'evt_6',
        type: 'invoice.paid',
        created: 1000,
        data: { object: { id: 'in_6', payment_intent: 'pi_6', amount_paid: 13750, metadata: { familyId: 'f6', invoiceId: 'i6' } } },
      };
    }
    // U6, production shape: `payInvoice` creates Checkout in 'payment' mode,
    // so the event that actually fires is `payment_intent.succeeded`, which
    // carries no `payment_intent` field on itself — the id to retrieve is the
    // event object's OWN id (pi_7), the `referenceNumber`-style fallback.
    if (sig === 'fee-ok-pi') {
      return {
        id: 'evt_7',
        type: 'payment_intent.succeeded',
        created: 1000,
        data: { object: { id: 'pi_7', amount_received: 13750, metadata: { familyId: 'f7', invoiceId: 'i7' } } },
      };
    }
    // ─────────────────────────────────────────────────────────────────────
    // The shapes Stripe really delivers. Every fixture ABOVE hand-injects
    // metadata onto a PaymentIntent event, which is what let the card-rail
    // defect survive: Stripe does not copy Checkout Session metadata onto the
    // PaymentIntent, so before `payment_intent_data.metadata` shipped, the
    // real payload was `no-metadata` below.
    // ─────────────────────────────────────────────────────────────────────

    // What production actually produced. No `metadata` key at all.
    if (sig === 'no-metadata') {
      return {
        id: 'evt_8',
        type: 'payment_intent.succeeded',
        created: 1000,
        data: { object: { id: 'pi_8', amount_received: 5000 } },
      };
    }
    // The canonical Checkout event. Carries the SESSION metadata, and the
    // PaymentIntent id in `payment_intent` (SDK: Sessions.d.ts:215), not as
    // its own id — a different place than a payment_intent.succeeded event.
    if (sig === 'session-completed') {
      return {
        id: 'evt_9',
        type: 'checkout.session.completed',
        created: 1000,
        data: {
          object: {
            id: 'cs_9',
            payment_intent: 'pi_9',
            payment_status: 'paid',
            amount_total: 13750,
            metadata: { familyId: 'f9', invoiceId: 'i9' },
          },
        },
      };
    }
    // A session that completed without the money arriving.
    if (sig === 'session-unpaid') {
      return {
        id: 'evt_10',
        type: 'checkout.session.completed',
        created: 1000,
        data: {
          object: {
            id: 'cs_10',
            payment_intent: 'pi_10',
            payment_status: 'unpaid',
            amount_total: 13750,
            metadata: { familyId: 'f10', invoiceId: 'i10' },
          },
        },
      };
    }
    // ONE card payment, both events it delivers. Same PaymentIntent (pi_11),
    // two different event ids, and the SAME `created` second — Stripe's
    // `created` is seconds-granular, so the out-of-order guard's strict `<`
    // does not separate them.
    if (sig === 'dual-session') {
      return {
        id: 'evt_11a',
        type: 'checkout.session.completed',
        created: 1000,
        data: {
          object: {
            id: 'cs_11',
            payment_intent: 'pi_11',
            payment_status: 'paid',
            amount_total: 13750,
            metadata: { familyId: 'f11', invoiceId: 'i11' },
          },
        },
      };
    }
    if (sig === 'dual-pi') {
      return {
        id: 'evt_11b',
        type: 'payment_intent.succeeded',
        created: 1000,
        data: { object: { id: 'pi_11', amount_received: 13750, metadata: { familyId: 'f11', invoiceId: 'i11' } } },
      };
    }
    // ── chargebacks ──────────────────────────────────────────────────────
    // A Dispute object, shaped from the pinned SDK
    // (node_modules/stripe/cjs/resources/Disputes.d.ts, `interface Dispute`).
    // NOTE WHAT IS ABSENT: `metadata`. Stripe does not copy the PaymentIntent's
    // metadata onto a Dispute, so `familyId`/`invoiceId` are NOT on this
    // payload and a handler sitting behind the webhook's metadata gate would
    // 202 every chargeback.
    if (sig === 'dispute-created') {
      return {
        id: 'evt_20',
        type: 'charge.dispute.created',
        created: 2000,
        data: {
          object: {
            id: 'dp_20',
            amount: 13750,
            currency: 'usd',
            charge: 'ch_20',
            payment_intent: 'pi_20',
            reason: 'fraudulent',
            status: 'needs_response',
            is_charge_refundable: true,
          },
        },
      };
    }
    // The accounting mirrors of created/closed, on the SAME dispute (dp_20).
    // These say the money actually left the Stripe balance and came back;
    // `status` on the payload is the lifecycle field and the handler must NOT
    // write it from here, or a late funds event would rewrite the lifecycle.
    if (sig === 'dispute-funds-withdrawn') {
      return {
        id: 'evt_26',
        type: 'charge.dispute.funds_withdrawn',
        created: 2600,
        data: {
          object: {
            id: 'dp_20',
            amount: 13750,
            currency: 'usd',
            charge: 'ch_20',
            payment_intent: 'pi_20',
            reason: 'fraudulent',
            status: 'needs_response',
          },
        },
      };
    }
    if (sig === 'dispute-funds-reinstated') {
      return {
        id: 'evt_27',
        type: 'charge.dispute.funds_reinstated',
        created: 3100,
        data: {
          object: {
            id: 'dp_20',
            amount: 13750,
            currency: 'usd',
            charge: 'ch_20',
            payment_intent: 'pi_20',
            reason: 'fraudulent',
            status: 'won',
          },
        },
      };
    }
    // The sibling that stays routed-but-ignored: evidence churn, no money move
    // and no lifecycle transition of its own.
    if (sig === 'dispute-updated') {
      return {
        id: 'evt_28',
        type: 'charge.dispute.updated',
        created: 2500,
        data: { object: { id: 'dp_20', amount: 13750, charge: 'ch_20', payment_intent: 'pi_20' } },
      };
    }
    // Same dispute, closed in the operator's favour.
    if (sig === 'dispute-won') {
      return {
        id: 'evt_21',
        type: 'charge.dispute.closed',
        created: 3000,
        data: {
          object: {
            id: 'dp_20',
            amount: 13750,
            currency: 'usd',
            charge: 'ch_20',
            payment_intent: 'pi_20',
            reason: 'fraudulent',
            status: 'won',
            is_charge_refundable: false,
          },
        },
      };
    }
    // A dispute on a PaymentIntent with NO claim doc: the payment predates the
    // per-PaymentIntent claim. Attribution has to come from Stripe.
    if (sig === 'dispute-no-claim') {
      return {
        id: 'evt_22',
        type: 'charge.dispute.created',
        created: 2000,
        data: {
          object: {
            id: 'dp_22',
            amount: 5000,
            currency: 'usd',
            charge: 'ch_22',
            payment_intent: 'pi_22',
            reason: 'product_not_received',
            status: 'needs_response',
          },
        },
      };
    }
    // `payment_intent` is `string | PaymentIntent | null` in the SDK
    // (Disputes.d.ts), and null is a real delivered shape. The CHARGE id is
    // always there, so these two carry a null payment_intent and differ only in
    // what the Charge behind them turns out to hold.
    if (sig === 'dispute-charge-only') {
      return {
        id: 'evt_24',
        type: 'charge.dispute.created',
        created: 2000,
        data: {
          object: {
            id: 'dp_24',
            amount: 2500,
            currency: 'usd',
            charge: 'ch_24',
            payment_intent: null,
            reason: 'fraudulent',
            status: 'needs_response',
          },
        },
      };
    }
    if (sig === 'dispute-charge-no-metadata') {
      return {
        id: 'evt_25',
        type: 'charge.dispute.created',
        created: 2000,
        data: {
          object: {
            id: 'dp_25',
            amount: 3300,
            currency: 'usd',
            charge: 'ch_25',
            payment_intent: null,
            reason: 'fraudulent',
            status: 'needs_response',
          },
        },
      };
    }
    if (sig === 'dispute-orphan') {
      return {
        id: 'evt_23',
        type: 'charge.dispute.created',
        created: 2000,
        data: {
          object: {
            id: 'dp_23',
            amount: 900,
            currency: 'usd',
            charge: 'ch_23',
            payment_intent: null,
            reason: 'general',
            status: 'needs_response',
          },
        },
      };
    }
    // ── refunds, ignored by policy ───────────────────────────────────────
    if (sig === 'refunded') {
      return {
        id: 'evt_30',
        type: 'charge.refunded',
        created: 4000,
        data: { object: { id: 'ch_30', payment_intent: 'pi_30' } },
      };
    }
    // ── abandoned checkout ───────────────────────────────────────────────
    // A Session expiry carries the SESSION metadata payInvoice stamps, so it
    // resolves the invoice through the ordinary gate.
    if (sig === 'session-expired') {
      return {
        id: 'evt_40',
        type: 'checkout.session.expired',
        created: 5000,
        data: {
          object: {
            id: 'cs_40',
            payment_status: 'unpaid',
            metadata: { familyId: 'f40', invoiceId: 'i40' },
          },
        },
      };
    }
    throw new Error('bad-sig');
  },
}));

// Path-aware Firestore mock: records every write keyed by its full path so we
// can assert the flat invoice doc AND the mirror payments doc.
const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
const docState: Record<string, { exists: boolean; data: Record<string, unknown> | undefined }> = {};
// Canned SUBCOLLECTION query results, keyed by full collection path
// (e.g. 'invoices/i1/payments'). The state stamp reads this inside the txn.
const subDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};

// A write LANDS in `docState`, so a second delivery inside one test reads what
// the first one wrote. Without this the mock forgets everything between
// handler calls and a dedupe assertion would only be re-testing hand-set
// fixture state — which is the exact class of false assurance this suite is
// being fixed for.
function makeDocRef(path: string) {
  return {
    path,
    get: vi.fn(async () => {
      const s = docState[path] ?? { exists: false, data: undefined };
      return { exists: s.exists, data: () => s.data };
    }),
    set: vi.fn(async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      writes.push({ path, data });
      // Real merge semantics: a blind overwrite would drop `kinfolkId`/`total`
      // off the invoice doc after the first delivery and change what the
      // second one reads.
      docState[path] = {
        exists: true,
        data: opts?.merge ? { ...(docState[path]?.data ?? {}), ...data } : data,
      };
    }),
    // `create` refuses an existing doc, as Firestore's does. This is what makes
    // the idempotency ledgers honest here rather than aliases for `set`.
    create: vi.fn(async (data: Record<string, unknown>) => {
      if (docState[path]?.exists) throw new Error(`ALREADY_EXISTS: ${path}`);
      writes.push({ path, data });
      docState[path] = { exists: true, data };
    }),
    collection: (sub: string) => ({
      get: vi.fn(async () => ({
        docs: (subDocs[`${path}/${sub}`] ?? []).map((d) => ({ id: d.id, data: () => d.data })),
      })),
    }),
  };
}

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (path: string) => makeDocRef(path),
    collection: (col: string) => ({ doc: (id: string) => makeDocRef(`${col}/${id}`) }),
    runTransaction: async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        get: (ref: any) => ref.get(),
        create: (ref: any, data: Record<string, unknown>) => ref.create(data),
        // The third argument is `{ merge: true }` on the invoice patch, and
        // dropping it here silently turned a merge into an overwrite.
        set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) => ref.set(data, opts),
      };
      return cb(tx);
    },
  }),
}));
// Held on hoisted handles so the double-delivery tests can assert CALL COUNTS.
// `vi.mock`'s inline `vi.fn()` is unreachable from the suite and, being
// unreachable, was never cleared between tests either.
const auditMock = vi.hoisted(() => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: auditMock.writeAuditEntry }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('recipient-uid') }));
const notifyMock = vi.hoisted(() => ({ enqueueNotification: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: notifyMock.enqueueNotification }));
const logMock = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: logMock.logEvent }));

beforeEach(() => {
  writes.length = 0;
  for (const k of Object.keys(docState)) delete docState[k];
  for (const k of Object.keys(subDocs)) delete subDocs[k];
  logMock.logEvent.mockClear();
  auditMock.writeAuditEntry.mockClear();
  notifyMock.enqueueNotification.mockReset().mockResolvedValue([]);
  stripeMock.paymentIntentsRetrieve.mockReset();
  stripeMock.chargesRetrieve.mockReset();
});

describe('stripeWebhook', () => {
  it('rejects bad signature', async () => {
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'bad' }, rawBody: Buffer.from('{}') },
      { status, json, end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(400);
  });

  it('marks the FLAT invoice paid and writes a mirror payment doc', async () => {
    docState['invoices/i1'] = { exists: true, data: { kinfolkId: 'f1', amountDue: 25, total: 25 } };
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'good' }, rawBody: Buffer.from('{}') },
      { status, json, end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);

    // Flat invoice patched to the portal's paid heuristic (amountDue<=0 + status).
    const invoiceWrite = writes.find((w) => w.path === 'invoices/i1');
    expect(invoiceWrite).toBeDefined();
    expect(invoiceWrite!.data.status).toBe('paid');
    expect(invoiceWrite!.data.amountDue).toBe(0);
    // The state stamp rides the SAME transactional write. No manual payment in
    // the subcollection (Stripe mirrors into the ROOT payments collection), so
    // the label is believed and the doc freezes: paid/none.
    expect(invoiceWrite!.data.editScope).toBe('none');

    // Mirror payment doc, keyed by event id for idempotency.
    const paymentWrite = writes.find((w) => w.path === 'payments/evt_1');
    expect(paymentWrite).toBeDefined();
    expect(paymentWrite!.data.kinfolkId).toBe('f1');
    expect(paymentWrite!.data.amount).toBe(25);
    expect(paymentWrite!.data.paymentMethod).toBe('stripe');
    expect(paymentWrite!.data.referenceNumber).toBe('pi_1');

    // No write should touch the phantom nested path.
    expect(writes.some((w) => w.path.startsWith('families/'))).toBe(false);
  });

  it('resolves the family from legacy kinfolkId metadata when familyId absent', async () => {
    docState['invoices/i2'] = { exists: true, data: { kinfolkId: 'f2', amountDue: 10 } };
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'good-kinfolk' }, rawBody: Buffer.from('{}') },
      { status, json, end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);
    const paymentWrite = writes.find((w) => w.path === 'payments/evt_2');
    expect(paymentWrite).toBeDefined();
    expect(paymentWrite!.data.kinfolkId).toBe('f2');
    // payment_intent.succeeded carries no payment_intent field; falls back to object id.
    expect(paymentWrite!.data.referenceNumber).toBe('pi_2');
  });

  it('NOTE-57: records the amount from the Stripe event (amount_paid) over local invoice derivation', async () => {
    // Local invoice has NO usable amount; the event carries amount_paid=4200.
    docState['invoices/i3'] = { exists: true, data: { kinfolkId: 'f3' } };
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'event-amount' }, rawBody: Buffer.from('{}') },
      { status, json, end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);
    const paymentWrite = writes.find((w) => w.path === 'payments/evt_3');
    expect(paymentWrite).toBeDefined();
    expect(paymentWrite!.data.amount).toBe(4200);
    expect(paymentWrite!.data.amountResolved).toBe(true);
    expect(paymentWrite!.data.amountSource).toBe('stripe-event');
    // No unresolved-amount warning since the event supplied a real amount.
    expect(
      logMock.logEvent.mock.calls.some((c) => c[0]?.event === 'stripe.amount.unresolved'),
    ).toBe(false);
  });

  it('NOTE-57: flags amountResolved:false + warns (does NOT silently store null) when no amount resolves', async () => {
    // No amount on the event and none on the invoice doc.
    docState['invoices/i4'] = { exists: true, data: { kinfolkId: 'f4' } };
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'no-amount' }, rawBody: Buffer.from('{}') },
      { status, json, end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);
    const paymentWrite = writes.find((w) => w.path === 'payments/evt_4');
    expect(paymentWrite).toBeDefined();
    expect(paymentWrite!.data.amount).toBeNull();
    expect(paymentWrite!.data.amountResolved).toBe(false);
    expect(paymentWrite!.data.amountSource).toBe('unresolved');
    // Fail-loud: a warn log surfaces the unresolved amount for operator attention.
    const warn = logMock.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.amount.unresolved');
    expect(warn).toBeDefined();
    expect(warn?.[0]?.severity).toBe('warn');
  });

  it('stamps paid/all when a manually-recorded partial sits in the payments SUBCOLLECTION', async () => {
    // A $20 manual payment was recorded against this $40 invoice, then the
    // household paid the card link. The doc is labelled paid, but the
    // subcollection's evidence falls short of the total, which is exactly the
    // repairable shape invoiceEditPolicy keeps editable (paid + partial ->
    // 'all'), so the stamp must not freeze it.
    docState['invoices/i1'] = {
      exists: true,
      data: { kinfolkId: 'f1', amountDue: 20, total: 40, totalCents: 4000 },
    };
    subDocs['invoices/i1/payments'] = [{ id: 'p1', data: { amount: 20, amountCents: 2000 } }];
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'good' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    );
    const invoiceWrite = writes.find((w) => w.path === 'invoices/i1');
    expect(invoiceWrite!.data.status).toBe('paid');
    expect(invoiceWrite!.data.editScope).toBe('all');
  });

  it('is idempotent — a replayed event id does not re-write', async () => {
    docState['invoices/i1'] = { exists: true, data: { kinfolkId: 'f1', amountDue: 25 } };
    docState['stripeEvents/evt_1'] = { exists: true, data: { type: 'invoice.paid' } };
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'good' }, rawBody: Buffer.from('{}') },
      { status, json, end: vi.fn() },
    );
    // Dedupe short-circuits: no invoice/payment write at all.
    expect(writes.some((w) => w.path === 'invoices/i1')).toBe(false);
    expect(writes.some((w) => w.path === 'payments/evt_1')).toBe(false);
    expect(status).toHaveBeenCalledWith(200);
  });

  // U6: capture the Stripe processor fee. The fee lives on the charge's
  // balance transaction, not the event, so it takes one retrieve — a
  // PaymentIntent fetch with a nested expand, since the webhook payload never
  // carries `balance_transaction` itself.
  it('stores the processor fee from the balance transaction', async () => {
    docState['invoices/i5'] = { exists: true, data: { kinfolkId: 'f5' } };
    stripeMock.paymentIntentsRetrieve.mockResolvedValue({
      latest_charge: { balance_transaction: { fee: 271 } },
    });
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'fee-ok' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);
    expect(stripeMock.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_5', {
      expand: ['latest_charge.balance_transaction'],
    });
    const paymentWrite = writes.find((w) => w.path === 'payments/evt_5');
    expect(paymentWrite).toBeDefined();
    expect(paymentWrite!.data).toMatchObject({
      amount: 13750,
      amountCents: 13750,
      feeCents: 271,
      feeResolved: true,
    });
    expect(
      logMock.logEvent.mock.calls.some((c) => c[0]?.event === 'stripe.fee.unresolved'),
    ).toBe(false);
  });

  it('records the payment with the fee unset when Stripe does not return one, and says so', async () => {
    docState['invoices/i6'] = { exists: true, data: { kinfolkId: 'f6' } };
    stripeMock.paymentIntentsRetrieve.mockRejectedValue(new Error('not available'));
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'fee-fail' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);
    const paymentWrite = writes.find((w) => w.path === 'payments/evt_6');
    expect(paymentWrite).toBeDefined();
    // The payment itself is real and unaffected: the amount still lands.
    expect(paymentWrite!.data.amountCents).toBe(13750);
    // A `feeCents: 0` would claim Stripe charged nothing. The field is absent,
    // not zero, and the doc says so via `feeResolved`.
    expect(paymentWrite!.data.feeCents).toBeUndefined();
    expect(paymentWrite!.data.feeResolved).toBe(false);
    const warn = logMock.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.fee.unresolved');
    expect(warn).toBeDefined();
    expect(warn?.[0]?.severity).toBe('warn');
  });

  it('resolves the fee on a payment_intent.succeeded event (the shape payInvoice actually produces)', async () => {
    docState['invoices/i7'] = { exists: true, data: { kinfolkId: 'f7' } };
    stripeMock.paymentIntentsRetrieve.mockResolvedValue({
      latest_charge: { balance_transaction: { fee: 271 } },
    });
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'fee-ok-pi' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);
    // No `payment_intent` field on the event object itself — the retrieve
    // must fall back to the event object's own id, not skip the lookup.
    expect(stripeMock.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_7', {
      expand: ['latest_charge.balance_transaction'],
    });
    const paymentWrite = writes.find((w) => w.path === 'payments/evt_7');
    expect(paymentWrite).toBeDefined();
    expect(paymentWrite!.data).toMatchObject({ feeCents: 271, feeResolved: true });
  });

  // ── the card rail ────────────────────────────────────────────────────────

  /**
   * The test whose absence let the defect ship. It pins the GUARD, not the
   * fix: it was green before `payment_intent_data.metadata` existed and is
   * green after. What it proves is that the metadata gate is the thing that
   * swallowed every real payment — silently, with a 202 Stripe records as a
   * successful delivery, so no retry and no dashboard red mark.
   */
  it('202-ignores a payment_intent.succeeded carrying no metadata, and warns', async () => {
    docState['invoices/i8'] = { exists: true, data: { kinfolkId: 'f8', amountDue: 50 } };
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'no-metadata' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(202);
    // Nothing at all was written: not the invoice, not a payment, and not the
    // dedupe ledger. The gate precedes the reservation, which is what makes a
    // swallowed event replayable once metadata starts arriving.
    expect(writes).toHaveLength(0);
    expect(auditMock.writeAuditEntry).not.toHaveBeenCalled();
    expect(notifyMock.enqueueNotification).not.toHaveBeenCalled();
    const warn = logMock.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.metadata.missing');
    expect(warn).toBeDefined();
    expect(warn?.[0]?.severity).toBe('warn');
  });

  it('marks the invoice paid from checkout.session.completed, end to end', async () => {
    docState['invoices/i9'] = { exists: true, data: { kinfolkId: 'f9', amountDue: 137.5, total: 137.5 } };
    stripeMock.paymentIntentsRetrieve.mockResolvedValue({
      latest_charge: { balance_transaction: { fee: 429 } },
    });
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'session-completed' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(200);

    const invoiceWrite = writes.find((w) => w.path === 'invoices/i9');
    expect(invoiceWrite!.data.status).toBe('paid');
    expect(invoiceWrite!.data.amountDue).toBe(0);

    // The fee hop still works on this event shape: a Session carries the
    // PaymentIntent id in `payment_intent`, NOT as its own id (which is a
    // `cs_...`). Retrieving `cs_9` would 404 and lose the fee silently.
    expect(stripeMock.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_9', {
      expand: ['latest_charge.balance_transaction'],
    });

    const paymentWrite = writes.find((w) => w.path === 'payments/evt_9');
    expect(paymentWrite!.data).toMatchObject({
      kinfolkId: 'f9',
      invoiceId: 'i9',
      // `amount_total` — the Session's authoritative figure, integer cents. NOT
      // 13750 re-derived from the local invoice's 137.5 dollars.
      amountCents: 13750,
      amountSource: 'stripe-event',
      referenceNumber: 'pi_9',
      feeCents: 429,
      feeResolved: true,
    });
    // The household is told, and the operator gets an audit trail — the two
    // things that never fired once on this rail.
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(notifyMock.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(notifyMock.enqueueNotification.mock.calls[0][0].key).toBe('invoice.payment.applied');
  });

  it('refuses to mark paid when the session completed but the money did not arrive', async () => {
    docState['invoices/i10'] = { exists: true, data: { kinfolkId: 'f10', amountDue: 137.5 } };
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const status = vi.fn().mockReturnThis();
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'session-unpaid' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    );
    expect(status).toHaveBeenCalledWith(202);
    expect(writes).toHaveLength(0);
    expect(auditMock.writeAuditEntry).not.toHaveBeenCalled();
    const warn = logMock.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.session.unpaid');
    expect(warn?.[0]?.severity).toBe('warn');
  });

  /**
   * The interaction the two fixes create. `checkout.session.completed` and
   * `payment_intent.succeeded` now BOTH classify as paid, and they carry
   * different `event.id`s — so `stripeEvents/{event.id}` cannot dedupe them
   * against each other, and their `created` stamps are the same second, so the
   * out-of-order guard's strict `<` does not either. The per-PaymentIntent
   * claim is what makes one payment apply once.
   *
   * Delivered in both orders because Stripe guarantees no ordering between them.
   */
  for (const [first, second, winner] of [
    ['dual-session', 'dual-pi', 'evt_11a'],
    ['dual-pi', 'dual-session', 'evt_11b'],
  ] as const) {
    it(`applies ONE payment when one card charge delivers both events (${first} first)`, async () => {
      docState['invoices/i11'] = { exists: true, data: { kinfolkId: 'f11', amountDue: 137.5, total: 137.5 } };
      stripeMock.paymentIntentsRetrieve.mockResolvedValue({
        latest_charge: { balance_transaction: { fee: 429 } },
      });
      const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
      const statuses: number[] = [];
      const res = () => ({
        status: vi.fn((c: number) => { statuses.push(c); return res2; }),
        json: vi.fn(),
        end: vi.fn(),
      });
      const res2 = { json: vi.fn(), end: vi.fn() };
      for (const sig of [first, second]) {
        await (stripeWebhookHandler as any)(
          { method: 'POST', headers: { 'stripe-signature': sig }, rawBody: Buffer.from('{}') },
          res(),
        );
      }
      // Both deliveries are acknowledged 2xx, so Stripe stops retrying either.
      expect(statuses).toEqual([200, 200]);

      // ONE mirror payment doc. Two would double-count real money in the root
      // `payments` collection that the ledger reads.
      const paymentWrites = writes.filter((w) => w.path.startsWith('payments/'));
      expect(paymentWrites).toHaveLength(1);
      expect(paymentWrites[0].path).toBe(`payments/${winner}`);
      // Same amount whichever event won the race: `amount_total` and
      // `amount_received` are the same authoritative integer cents.
      expect(paymentWrites[0].data.amountCents).toBe(13750);
      expect(paymentWrites[0].data.amountSource).toBe('stripe-event');

      // ONE invoice mutation, and exactly one claim on the shared PaymentIntent.
      expect(writes.filter((w) => w.path === 'invoices/i11')).toHaveLength(1);
      expect(writes.filter((w) => w.path === 'stripePayments/pi_11')).toHaveLength(1);

      // The loser reserved its own event id — so ITS retries short-circuit as
      // a replay — and recorded why it changed nothing.
      const loserId = winner === 'evt_11a' ? 'evt_11b' : 'evt_11a';
      const loserLedger = writes.find((w) => w.path === `stripeEvents/${loserId}`);
      expect(loserLedger!.data.appliedOutcome).toBe('SKIPPED_DUPLICATE_PAYMENT');

      // The household is notified once and audited once, not twice.
      expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
      expect(notifyMock.enqueueNotification).toHaveBeenCalledTimes(1);
    });
  }

  // ── chargebacks ──────────────────────────────────────────────────────────

  /** Runs one delivery and returns the status codes it produced. */
  async function deliver(sig: string): Promise<number[]> {
    const { stripeWebhookHandler } = await import('../src/billing/stripeWebhook');
    const codes: number[] = [];
    const tail = { json: vi.fn(), end: vi.fn() };
    await (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': sig }, rawBody: Buffer.from('{}') },
      { status: vi.fn((c: number) => { codes.push(c); return tail; }), json: vi.fn(), end: vi.fn() },
    );
    return codes;
  }

  it('records a dispute and leaves the invoice READING PAID', async () => {
    docState['invoices/i20'] = {
      exists: true,
      data: { kinfolkId: 'f20', status: 'paid', amountDue: 0, total: 137.5 },
    };
    // The claim the paid path wrote. This is the attribution route.
    docState['stripePayments/pi_20'] = {
      exists: true,
      data: { appliedEventId: 'evt_9', familyId: 'f20', invoiceId: 'i20' },
    };

    expect(await deliver('dispute-created')).toEqual([200]);

    const disputeWrite = writes.find((w) => w.path === 'stripeDisputes/dp_20');
    expect(disputeWrite!.data).toMatchObject({
      disputeId: 'dp_20',
      paymentIntentId: 'pi_20',
      chargeId: 'ch_20',
      familyId: 'f20',
      invoiceId: 'i20',
      subjectSource: 'payment-claim',
      amountCents: 13750,
      amountResolved: true,
      reason: 'fraudulent',
      status: 'needs_response',
    });

    // THE DECISION UNDER TEST. The invoice is flagged and nothing else: no
    // `status`, no `amountDue`, no state stamp, no reversing payment row. A
    // flip to unpaid would restart `invoiceRemindersCron` against a household
    // over their own bank's action, and a negative payments row would invent a
    // reversal the operator never made.
    const invoiceWrite = writes.find((w) => w.path === 'invoices/i20');
    expect(invoiceWrite!.data).toMatchObject({
      disputeStatus: 'needs_response',
      disputeId: 'dp_20',
      disputeAmountCents: 13750,
    });
    expect(invoiceWrite!.data.status).toBeUndefined();
    expect(invoiceWrite!.data.amountDue).toBeUndefined();
    expect(invoiceWrite!.data.editScope).toBeUndefined();
    expect(writes.some((w) => w.path.startsWith('payments/'))).toBe(false);
    // The stored doc still reads paid after the merge.
    expect(docState['invoices/i20'].data!.status).toBe('paid');
    expect(docState['invoices/i20'].data!.amountDue).toBe(0);

    // Critical audit + the business-stream ping, and an error-stream log so it
    // is not only discoverable by opening a collection.
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(auditMock.writeAuditEntry.mock.calls[0][0]).toMatchObject({
      event: 'BILLING_PAYMENT_DISPUTED',
      severity: 'critical',
      status: 'PENDING',
      familyId: 'f20',
    });
    expect(notifyMock.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(notifyMock.enqueueNotification.mock.calls[0][0].key).toBe('invoice.payment.disputed');
    expect(notifyMock.enqueueNotification.mock.calls[0][0].data.disputeAmount).toBe('$137.50');
    const loud = logMock.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.dispute.created');
    expect(loud?.[0]?.severity).toBe('error');
  });

  it('is idempotent under a redelivered dispute: one audit, one notification', async () => {
    docState['invoices/i20'] = { exists: true, data: { kinfolkId: 'f20', status: 'paid', amountDue: 0 } };
    docState['stripePayments/pi_20'] = { exists: true, data: { familyId: 'f20', invoiceId: 'i20' } };

    expect(await deliver('dispute-created')).toEqual([200]);
    expect(await deliver('dispute-created')).toEqual([200]);

    expect(writes.filter((w) => w.path === 'stripeDisputes/dp_20')).toHaveLength(1);
    expect(writes.filter((w) => w.path === 'invoices/i20')).toHaveLength(1);
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(notifyMock.enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('closes a won dispute at info severity and still never touches the paid state', async () => {
    docState['invoices/i20'] = { exists: true, data: { kinfolkId: 'f20', status: 'paid', amountDue: 0 } };
    docState['stripePayments/pi_20'] = { exists: true, data: { familyId: 'f20', invoiceId: 'i20' } };

    expect(await deliver('dispute-created')).toEqual([200]);
    expect(await deliver('dispute-won')).toEqual([200]);

    // Two events, two ledger reservations, two audit entries — the created and
    // closed halves dedupe independently because they carry different ids.
    expect(writes.filter((w) => w.path === 'stripeEvents/evt_20')).toHaveLength(1);
    expect(writes.filter((w) => w.path === 'stripeEvents/evt_21')).toHaveLength(1);
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(2);
    expect(auditMock.writeAuditEntry.mock.calls[1][0]).toMatchObject({
      event: 'BILLING_PAYMENT_DISPUTE_CLOSED',
      severity: 'info',
      status: 'SUCCESS',
    });
    expect(docState['stripeDisputes/dp_20'].data!.status).toBe('won');
    expect(docState['invoices/i20'].data!.disputeStatus).toBe('won');
    expect(docState['invoices/i20'].data!.status).toBe('paid');
  });

  it('refuses to un-close a dispute when the created event arrives after the closed one', async () => {
    docState['invoices/i20'] = { exists: true, data: { kinfolkId: 'f20', status: 'paid', amountDue: 0 } };
    docState['stripePayments/pi_20'] = { exists: true, data: { familyId: 'f20', invoiceId: 'i20' } };

    // Stripe guarantees no ordering between the two. `won` (created: 3000)
    // lands first, then the opening event (created: 2000) shows up late.
    expect(await deliver('dispute-won')).toEqual([200]);
    expect(await deliver('dispute-created')).toEqual([200]);

    // The record still says won. Reverting it to `needs_response` would send
    // the operator to fight a dispute that is already settled.
    expect(docState['stripeDisputes/dp_20'].data!.status).toBe('won');
    expect(writes.find((w) => w.path === 'stripeEvents/evt_20')!.data.appliedOutcome).toBe(
      'SKIPPED_OUT_OF_ORDER',
    );
    // The skipped event fires neither of the two side effects.
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(notifyMock.enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('attributes a dispute from the PaymentIntent metadata when no claim doc exists', async () => {
    docState['invoices/i22'] = { exists: true, data: { kinfolkId: 'f22', status: 'paid', amountDue: 0 } };
    // No `stripePayments/pi_22`: this payment predates the claim.
    stripeMock.paymentIntentsRetrieve.mockResolvedValue({
      metadata: { familyId: 'f22', invoiceId: 'i22' },
    });

    expect(await deliver('dispute-no-claim')).toEqual([200]);

    expect(stripeMock.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_22');
    expect(writes.find((w) => w.path === 'stripeDisputes/dp_22')!.data).toMatchObject({
      familyId: 'f22',
      invoiceId: 'i22',
      subjectSource: 'payment-intent-metadata',
    });
    expect(writes.some((w) => w.path === 'invoices/i22')).toBe(true);
  });

  it('attributes a dispute with no payment_intent through the CHARGE it names', async () => {
    docState['invoices/i24'] = { exists: true, data: { kinfolkId: 'f24', status: 'paid', amountDue: 0 } };
    // Stripe copies a PaymentIntent's metadata onto its Charge, an assumption
    // this repo already asserts in `stripeWebhook.ts` and which the pinned
    // SDK's own type definitions do NOT state anywhere. So it is used as a LAST
    // resort only, after the charge's `payment_intent` has been tried: see the
    // next test, which is the one that holds if the copy never happens.
    stripeMock.chargesRetrieve.mockResolvedValue({
      id: 'ch_24',
      payment_intent: null,
      metadata: { familyId: 'f24', invoiceId: 'i24' },
    });

    expect(await deliver('dispute-charge-only')).toEqual([200]);

    expect(stripeMock.chargesRetrieve).toHaveBeenCalledWith('ch_24');
    expect(writes.find((w) => w.path === 'stripeDisputes/dp_24')!.data).toMatchObject({
      familyId: 'f24',
      invoiceId: 'i24',
      subjectSource: 'charge-metadata',
    });
    expect(writes.some((w) => w.path === 'invoices/i24')).toBe(true);
  });

  it('still attributes through the charge when the Charge carries NO metadata at all', async () => {
    docState['invoices/i25'] = { exists: true, data: { kinfolkId: 'f25', status: 'paid', amountDue: 0 } };
    // The shape the metadata-copy assumption does NOT cover: an empty
    // `metadata` on the Charge. The route that carries this one is the Charge's
    // `payment_intent` field, which the SDK does declare (Charges.d.ts:161), so
    // attribution lands on the claim doc, the same source that decided which
    // invoice the money applied to in the first place.
    docState['stripePayments/pi_25'] = { exists: true, data: { familyId: 'f25', invoiceId: 'i25' } };
    stripeMock.chargesRetrieve.mockResolvedValue({ id: 'ch_25', payment_intent: 'pi_25', metadata: {} });

    expect(await deliver('dispute-charge-no-metadata')).toEqual([200]);

    expect(stripeMock.chargesRetrieve).toHaveBeenCalledWith('ch_25');
    const disputeWrite = writes.find((w) => w.path === 'stripeDisputes/dp_25')!;
    expect(disputeWrite.data).toMatchObject({
      familyId: 'f25',
      invoiceId: 'i25',
      subjectSource: 'payment-claim',
      // Discovered through the charge, so it is RECORDED: the dispute payload
      // never carried it and an operator reading this doc should not have to
      // go back to Stripe to find the PaymentIntent a second time.
      paymentIntentId: 'pi_25',
    });
  });

  it('records an unattributable dispute rather than dropping it, and says it is unattributed', async () => {
    // `payment_intent: null` AND a Charge that yields nothing: no route to a
    // household at all. The charge IS retrieved, and asserting that it was is what
    // stops this test passing on a `charges.retrieve` that throws.
    stripeMock.chargesRetrieve.mockResolvedValue({ id: 'ch_23', payment_intent: null, metadata: {} });
    expect(await deliver('dispute-orphan')).toEqual([200]);

    // The money is still gone, so the record still lands — keyed by dispute id,
    // carrying the charge id, with the attribution explicitly absent rather
    // than guessed at.
    const disputeWrite = writes.find((w) => w.path === 'stripeDisputes/dp_23');
    expect(disputeWrite!.data).toMatchObject({
      chargeId: 'ch_23',
      paymentIntentId: null,
      familyId: null,
      invoiceId: null,
      subjectSource: 'unresolved',
      amountCents: 900,
    });
    // No invoice to flag. The charge route was tried and answered nothing; the
    // PaymentIntent route had no id to try at all.
    expect(writes.some((w) => w.path.startsWith('invoices/'))).toBe(false);
    expect(stripeMock.chargesRetrieve).toHaveBeenCalledWith('ch_23');
    expect(stripeMock.paymentIntentsRetrieve).not.toHaveBeenCalled();
    // The operator still hears about it: the audit entry lands with no familyId.
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
    expect(auditMock.writeAuditEntry.mock.calls[0][0].familyId).toBeUndefined();
    expect(auditMock.writeAuditEntry.mock.calls[0][0].payload.subjectSource).toBe('unresolved');
  });

  // ── refunds: ignored by policy, and visibly so ───────────────────────────

  it('202-ignores a refund event under the no-refunds ruling, WITHOUT a metadata warning', async () => {
    expect(await deliver('refunded')).toEqual([202]);
    expect(writes).toHaveLength(0);
    expect(auditMock.writeAuditEntry).not.toHaveBeenCalled();
    // The point of the named branch. A refund object carries no payInvoice
    // metadata, so behind the gate this logged `stripe.metadata.missing` — a
    // warning naming a defect that is not there, on an event ignored on
    // purpose. The deliberate ignore now logs as itself.
    expect(
      logMock.logEvent.mock.calls.some((c) => c[0]?.event === 'stripe.metadata.missing'),
    ).toBe(false);
    const ignored = logMock.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.refund.ignored');
    expect(ignored?.[0]?.severity).toBe('info');
  });

  it('202-ignores an unhandled dispute sibling by name, not as missing metadata', async () => {
    expect(await deliver('dispute-updated')).toEqual([202]);
    expect(writes).toHaveLength(0);
    expect(auditMock.writeAuditEntry).not.toHaveBeenCalled();
    // The reason the WHOLE `charge.dispute.` prefix routes to the dispute
    // handler rather than only the types it acts on. A sibling left to fall
    // through reaches the metadata gate, and a Dispute carries none, so it would
    // warn `stripe.metadata.missing` on a chargeback: a defect that is not there.
    // This branch is what keeps that promise for the events not handled yet.
    expect(
      logMock.logEvent.mock.calls.some((c) => c[0]?.event === 'stripe.metadata.missing'),
    ).toBe(false);
    const ignored = logMock.logEvent.mock.calls.find(
      (c) => c[0]?.event === 'stripe.dispute.unhandledType',
    );
    expect(ignored?.[0]?.severity).toBe('info');
    // Named, so an operator who subscribes it sees it arriving and ignored.
    expect(ignored?.[0]?.extra?.eventType).toBe('charge.dispute.updated');
  });

  // ── the balance actually moving: funds_withdrawn / funds_reinstated ──────

  /** The two side effects a dispute record must show for the disputed money. */
  function disputeFixtures() {
    docState['invoices/i20'] = {
      exists: true,
      data: { kinfolkId: 'f20', status: 'paid', amountDue: 0, total: 137.5 },
    };
    docState['stripePayments/pi_20'] = { exists: true, data: { familyId: 'f20', invoiceId: 'i20' } };
  }

  it('records funds_withdrawn as its OWN fact and does not touch disputeStatus', async () => {
    disputeFixtures();

    expect(await deliver('dispute-created')).toEqual([200]);
    expect(await deliver('dispute-funds-withdrawn')).toEqual([200]);

    // The whole point: `status` mirrors Stripe's dispute LIFECYCLE, `fundsState`
    // says whether the balance has actually been debited. Two different facts,
    // two different fields: a dispute can sit at `needs_response` with the
    // money already gone, and that is exactly this state.
    expect(docState['stripeDisputes/dp_20'].data).toMatchObject({
      status: 'needs_response',
      fundsState: 'withdrawn',
    });
    expect(docState['invoices/i20'].data).toMatchObject({
      disputeStatus: 'needs_response',
      disputeFundsState: 'withdrawn',
      // Still reading paid. A balance debit is not a decision to un-pay.
      status: 'paid',
      amountDue: 0,
    });

    // Its own audit key, so "which disputes have actually debited the balance"
    // is answerable by querying `event` and not by reading every payload.
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(2);
    expect(auditMock.writeAuditEntry.mock.calls[1][0]).toMatchObject({
      event: 'BILLING_PAYMENT_DISPUTE_FUNDS_WITHDRAWN',
      severity: 'critical',
      status: 'FAILURE',
      familyId: 'f20',
    });
    expect(auditMock.writeAuditEntry.mock.calls[1][0].payload).toMatchObject({
      fundsState: 'withdrawn',
      disputeId: 'dp_20',
    });
    // No SECOND ping. The operator was already notified when the dispute
    // opened, minutes earlier, and this event asks nothing new of them.
    expect(notifyMock.enqueueNotification).toHaveBeenCalledTimes(1);
    const loud = logMock.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.dispute.fundsWithdrawn');
    expect(loud?.[0]?.severity).toBe('error');
  });

  it('records funds_reinstated as the good-news half', async () => {
    disputeFixtures();

    expect(await deliver('dispute-created')).toEqual([200]);
    expect(await deliver('dispute-funds-withdrawn')).toEqual([200]);
    expect(await deliver('dispute-funds-reinstated')).toEqual([200]);

    expect(docState['stripeDisputes/dp_20'].data!.fundsState).toBe('reinstated');
    expect(docState['invoices/i20'].data!.disputeFundsState).toBe('reinstated');
    // The lifecycle never moved: no `closed` event was delivered here, and a
    // funds event must not invent one.
    expect(docState['stripeDisputes/dp_20'].data!.status).toBe('needs_response');
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(3);
    expect(auditMock.writeAuditEntry.mock.calls[2][0]).toMatchObject({
      event: 'BILLING_PAYMENT_DISPUTE_FUNDS_REINSTATED',
      severity: 'info',
      status: 'SUCCESS',
    });
  });

  it('keeps the funds fact even when it arrives after the dispute already closed', async () => {
    disputeFixtures();

    // Stripe guarantees no ordering. `closed`/won (created: 3000) lands first,
    // then the withdrawal (created: 2600) shows up late. The lifecycle guard
    // must NOT swallow it: the money did leave the balance, and a dropped
    // accounting fact is a hole in the record, not a protected invariant.
    expect(await deliver('dispute-won')).toEqual([200]);
    expect(await deliver('dispute-funds-withdrawn')).toEqual([200]);

    expect(docState['stripeDisputes/dp_20'].data).toMatchObject({
      status: 'won',
      fundsState: 'withdrawn',
    });
    expect(writes.find((w) => w.path === 'stripeEvents/evt_26')!.data.appliedOutcome).toBe(
      'DISPUTE_FUNDS_WITHDRAWN',
    );
  });

  it('refuses an out-of-order funds event within the funds lane', async () => {
    disputeFixtures();

    // Reinstatement (created: 3100) first, then a late withdrawal (2600).
    // Applying it would tell the operator the money is gone when it is back.
    expect(await deliver('dispute-funds-reinstated')).toEqual([200]);
    expect(await deliver('dispute-funds-withdrawn')).toEqual([200]);

    expect(docState['stripeDisputes/dp_20'].data!.fundsState).toBe('reinstated');
    expect(writes.find((w) => w.path === 'stripeEvents/evt_26')!.data.appliedOutcome).toBe(
      'SKIPPED_OUT_OF_ORDER',
    );
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
  });

  it('is idempotent under a redelivered funds event', async () => {
    disputeFixtures();

    expect(await deliver('dispute-funds-withdrawn')).toEqual([200]);
    expect(await deliver('dispute-funds-withdrawn')).toEqual([200]);

    expect(writes.filter((w) => w.path === 'stripeDisputes/dp_20')).toHaveLength(1);
    expect(writes.filter((w) => w.path === 'invoices/i20')).toHaveLength(1);
    expect(auditMock.writeAuditEntry).toHaveBeenCalledTimes(1);
  });

  it('records a funds movement for a dispute whose created event never arrived', async () => {
    // The operator subscribed the funds events and not `charge.dispute.created`,
    // or the created event was lost. The balance still moved, so the record
    // still lands, with the lifecycle field honestly absent rather than guessed.
    disputeFixtures();

    expect(await deliver('dispute-funds-withdrawn')).toEqual([200]);

    expect(docState['stripeDisputes/dp_20'].data).toMatchObject({
      disputeId: 'dp_20',
      fundsState: 'withdrawn',
      familyId: 'f20',
      invoiceId: 'i20',
      amountCents: 13750,
    });
    expect(docState['stripeDisputes/dp_20'].data!.status).toBeUndefined();
    expect(docState['invoices/i20'].data!.disputeStatus).toBeUndefined();
    expect(docState['invoices/i20'].data!.disputeFundsState).toBe('withdrawn');
  });
  // ── abandoned checkout ───────────────────────────────────────────────────

  it('clears the pending checkout fields when the session expires', async () => {
    docState['invoices/i40'] = {
      exists: true,
      data: { kinfolkId: 'f40', amountDue: 137.5, pendingCheckoutSessionId: 'cs_40', pendingAt: new Date(0) },
    };
    expect(await deliver('session-expired')).toEqual([200]);

    const invoiceWrite = writes.find((w) => w.path === 'invoices/i40');
    expect(invoiceWrite!.data.pendingCheckoutSessionId).toEqual(FieldValue.delete());
    expect(invoiceWrite!.data.pendingAt).toEqual(FieldValue.delete());
    // Money fields untouched: an abandoned checkout says nothing about what is owed.
    expect(invoiceWrite!.data.status).toBeUndefined();
    expect(invoiceWrite!.data.amountDue).toBeUndefined();
    expect(auditMock.writeAuditEntry).not.toHaveBeenCalled();
    expect(notifyMock.enqueueNotification).not.toHaveBeenCalled();
  });

  it('leaves a NEWER pending session alone when an older one expires', async () => {
    // The household abandoned cs_40, started cs_41, and cs_40's expiry arrives
    // afterwards. An unconditional clear would wipe the live checkout.
    docState['invoices/i40'] = {
      exists: true,
      data: { kinfolkId: 'f40', amountDue: 137.5, pendingCheckoutSessionId: 'cs_41' },
    };
    expect(await deliver('session-expired')).toEqual([200]);
    expect(writes).toHaveLength(0);
    expect(docState['invoices/i40'].data!.pendingCheckoutSessionId).toBe('cs_41');
  });

  it('re-delivery of an expiry it already handled writes nothing', async () => {
    docState['invoices/i40'] = {
      exists: true,
      data: { kinfolkId: 'f40', amountDue: 137.5, pendingCheckoutSessionId: 'cs_40' },
    };
    expect(await deliver('session-expired')).toEqual([200]);
    const after = writes.length;
    expect(await deliver('session-expired')).toEqual([200]);
    // Idempotent by construction: the second pass finds no matching id to clear,
    // so this branch needs no ledger entry of its own.
    expect(writes).toHaveLength(after);
  });

  it('a completed session clears the pending fields too', async () => {
    docState['invoices/i9'] = {
      exists: true,
      data: { kinfolkId: 'f9', amountDue: 137.5, total: 137.5, pendingCheckoutSessionId: 'cs_9' },
    };
    stripeMock.paymentIntentsRetrieve.mockResolvedValue({
      latest_charge: { balance_transaction: { fee: 429 } },
    });
    expect(await deliver('session-completed')).toEqual([200]);
    const invoiceWrite = writes.find((w) => w.path === 'invoices/i9');
    expect(invoiceWrite!.data.status).toBe('paid');
    expect(invoiceWrite!.data.pendingCheckoutSessionId).toEqual(FieldValue.delete());
    expect(invoiceWrite!.data.pendingAt).toEqual(FieldValue.delete());
  });
});
