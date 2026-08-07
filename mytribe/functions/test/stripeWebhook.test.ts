import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Stripe client's `paymentIntents.retrieve` — the ONE call the fee
// resolution makes, mocked per-test via `.mockResolvedValue` /
// `.mockRejectedValue`. `vi.hoisted` so the factory below (itself hoisted by
// vi.mock) can close over it.
const stripeMock = vi.hoisted(() => ({ paymentIntentsRetrieve: vi.fn() }));

// Stripe verifier stub. `good` → a paid event carrying familyId metadata;
// `good-kinfolk` → paid event carrying only the legacy kinfolkId metadata.
vi.mock('../src/lib/stripe', () => ({
  getStripe: async () => ({ paymentIntents: { retrieve: stripeMock.paymentIntentsRetrieve } }),
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
});
