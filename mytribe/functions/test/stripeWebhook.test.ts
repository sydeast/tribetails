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

function makeDocRef(path: string) {
  return {
    path,
    get: vi.fn(async () => {
      const s = docState[path] ?? { exists: false, data: undefined };
      return { exists: s.exists, data: () => s.data };
    }),
    set: vi.fn(async (data: Record<string, unknown>) => {
      writes.push({ path, data });
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
        create: (ref: any, data: Record<string, unknown>) => ref.set(data),
        set: (ref: any, data: Record<string, unknown>) => ref.set(data),
      };
      return cb(tx);
    },
  }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('recipient-uid') }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: vi.fn().mockResolvedValue([]) }));
const logMock = vi.hoisted(() => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: logMock.logEvent }));

beforeEach(() => {
  writes.length = 0;
  for (const k of Object.keys(docState)) delete docState[k];
  for (const k of Object.keys(subDocs)) delete subDocs[k];
  logMock.logEvent.mockClear();
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
});
