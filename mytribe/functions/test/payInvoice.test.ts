import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * The slice of Stripe's `checkout.sessions.create` params this suite asserts
 * on. Declaring it on the mock is what makes `mock.calls[0][0]` a real type
 * instead of `never` — an untyped `vi.fn(async () => ...)` records a zero-arg
 * call signature, so every assertion below was reaching into an empty tuple.
 */
interface CheckoutSessionParams {
  line_items: Array<{ price_data: { unit_amount: number } }>;
  metadata: Record<string, string>;
  /**
   * The parameter the webhook actually depends on. Session-level `metadata`
   * stays on the Session — Stripe copies nothing down to the PaymentIntent,
   * which is exactly why the SDK exposes this as a separate parameter
   * (`SessionCreateParams.PaymentIntentData.metadata`).
   */
  payment_intent_data?: { metadata?: Record<string, string> };
  [key: string]: unknown;
}

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  stripeMock: {
    checkout: {
      sessions: {
        create: vi.fn(async (_params: CheckoutSessionParams) => ({
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/test',
          client_secret: null,
        })),
        /**
         * Issue #826, the reuse path's one Stripe read.
         *
         * REJECTS by default, which is both what Stripe does with an id it does
         * not know and what keeps this suite honest: a resolving default would
         * make "did the reuse check even run?" unanswerable, because every test
         * that never stubs it would take the mint path for the right reason by
         * accident.
         */
        retrieve: vi.fn(async (_id: string): Promise<unknown> => {
          throw new Error('No such checkout.session');
        }),
      },
    },
  },
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/stripe', () => ({ getStripe: () => mocks.stripeMock }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.stripeMock.checkout.sessions.create.mockClear();
  mocks.stripeMock.checkout.sessions.retrieve.mockClear();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: false,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: true,
  },
};
const BILLING_FULL_SECONDARY = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: {
    billing_full: true,
    messaging_direct: false,
    messaging_group: false,
    kin_edit: false,
    kintales_only: false,
  },
};
const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };
const payData = { invoiceId: 'inv-1', successUrl: 'https://x/ok', cancelUrl: 'https://x/cancel' };

describe('payInvoice PRIMARY-only billing gate', () => {
  it('DENIES a kintales_only secondary and never creates a Checkout Session', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
        'families/3/members/u1': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mocks.stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(ctx.writes.find((w) => w.path === 'invoices/inv-1')).toBeUndefined();
  });

  it('DENIES a secondary with billing_full=true (PK-only policy: billing_full is no longer honored)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
        'families/3/members/u1': BILLING_FULL_SECONDARY,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mocks.stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(ctx.writes.find((w) => w.path === 'invoices/inv-1')).toBeUndefined();
  });

  it('ALLOWS a PRIMARY member', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
        'families/3/members/u1': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any);
    expect(res.sessionId).toBe('cs_test_1');
    expect(mocks.stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });

  it('ALLOWS legacy (no member doc)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any);
    expect(res.sessionId).toBe('cs_test_1');
  });

  it('ALLOWS an operator (bypass, no member doc)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: {
        'clients/op-uid': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: payData, auth: { uid: 'op-uid' } } as any);
    expect(res.sessionId).toBe('cs_test_1');
  });
});

describe('payInvoiceHandler', () => {
  it('rejects unauth', async () => {
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(
      payInvoiceHandler({
        data: { invoiceId: '1', successUrl: 'https://x', cancelUrl: 'https://y' },
        auth: undefined,
      } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects when invoice missing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(
      payInvoiceHandler({
        data: { invoiceId: 'missing', successUrl: 'https://x', cancelUrl: 'https://y' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects when invoice belongs to another tribe', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-9': { kinfolkId: '99', amountDue: 50 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(
      payInvoiceHandler({
        data: { invoiceId: 'inv-9', successUrl: 'https://x', cancelUrl: 'https://y' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects fully paid invoices', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-paid': { kinfolkId: '3', amountDue: 0 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(
      payInvoiceHandler({
        data: { invoiceId: 'inv-paid', successUrl: 'https://x', cancelUrl: 'https://y' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('creates a Checkout Session and returns the URL', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5, client: 'Buddy (Nora)' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({
      data: { invoiceId: 'inv-1', successUrl: 'https://x/ok', cancelUrl: 'https://x/cancel' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.checkoutUrl).toContain('checkout.stripe.com');
    expect(res.sessionId).toBe('cs_test_1');
    expect(res.amountCents).toBe(1250);

    const callArg = mocks.stripeMock.checkout.sessions.create.mock.calls[0][0];
    expect(callArg.line_items[0].price_data.unit_amount).toBe(1250);
    expect(callArg.metadata.invoiceId).toBe('inv-1');
    expect(callArg.metadata.kinfolkId).toBe('3');
    // Webhook resolves on familyId; payInvoice must stamp it (plus kinfolkId).
    expect(callArg.metadata.familyId).toBe('3');

    const w = ctx.writes.find((w) => w.path === 'invoices/inv-1');
    expect(w!.data.pendingCheckoutSessionId).toBe('cs_test_1');
  });

  /**
   * The seam the whole card rail turns on. `stripeWebhook` resolves the
   * household and the invoice from `payment_intent.succeeded`'s
   * `data.object.metadata` — PAYMENTINTENT metadata. Stripe does not copy
   * Session metadata onto the PaymentIntent, so the assertion above (on
   * `metadata`) is an assertion on the object the webhook never reads.
   *
   * This one asserts the object it does read. Without
   * `payment_intent_data.metadata` the webhook sees `{}`, 202-ignores the
   * event, and the invoice stays outstanding after a real charge.
   */
  it('stamps the SAME ids on payment_intent_data.metadata, the copy the webhook reads', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5, client: 'Buddy (Nora)' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({
      data: { invoiceId: 'inv-1', successUrl: 'https://x/ok', cancelUrl: 'https://x/cancel' },
      auth: { uid: 'u1' },
    } as any);

    const callArg = mocks.stripeMock.checkout.sessions.create.mock.calls[0][0];
    const piMeta = callArg.payment_intent_data?.metadata;
    expect(piMeta).toBeDefined();
    expect(piMeta!.familyId).toBe('3');
    expect(piMeta!.invoiceId).toBe('inv-1');
    expect(piMeta!.kinfolkId).toBe('3');
    // Identical, not merely similar: one drifting from the other resolves a
    // different household depending on which event Stripe delivers.
    expect(piMeta).toEqual(callArg.metadata);
  });
});

/**
 * ISSUE #409: which rails the Checkout Session accepts.
 *
 * `payment_method_types` was the literal `['card']`. Klarna and Affirm are
 * Stripe payment method types rather than separate integrations, so the whole
 * of "offer Klarna" is one more string in that array, derived from the
 * options the operator has switched on.
 */
describe('payInvoice payment_method_types (issue #409)', () => {
  const invoiceDocs = {
    'clients/u1': { kinfolkIds: ['3'] },
    'families/3/members/u1': PRIMARY_MEMBER,
  };

  it('offers card alone for an operator who has configured nothing', async () => {
    const ctx = buildDbMock({
      docs: {
        ...invoiceDocs,
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.create.mock.calls[0][0].payment_method_types).toEqual([
      'card',
    ]);
  });

  it('reaches Stripe with klarna and affirm once the operator turns them on', async () => {
    const ctx = buildDbMock({
      docs: {
        ...invoiceDocs,
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
        'business_settings/business_settings': {
          paymentOptions: { klarna: { enabled: true }, affirm: { enabled: true } },
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.create.mock.calls[0][0].payment_method_types).toEqual([
      'card',
      'klarna',
      'affirm',
    ]);
  });

  it("prefers the invoice's own frozen options over what settings say today", async () => {
    // The bill was issued while Klarna was on. The operator has since turned
    // it off. The household holding that bill still gets Klarna.
    const ctx = buildDbMock({
      docs: {
        ...invoiceDocs,
        'invoices/inv-1': {
          kinfolkId: '3',
          amountDue: 12.5,
          payMethodSettingsSnapshot: {
            capturedAt: '2026-08-01T00:00:00.000Z',
            paymentOptions: { klarna: { enabled: true } },
          },
        },
        'business_settings/business_settings': { paymentOptions: { klarna: { enabled: false } } },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.create.mock.calls[0][0].payment_method_types).toEqual([
      'card',
      'klarna',
    ]);
  });

  it('retries card-only when Stripe refuses a type the account has not activated', async () => {
    // The toggle lives here; the activation lives in the operator's Stripe
    // dashboard, and nothing makes them agree. When they disagree, the
    // household still gets to pay their bill.
    const ctx = buildDbMock({
      docs: {
        ...invoiceDocs,
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
        'business_settings/business_settings': { paymentOptions: { klarna: { enabled: true } } },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.checkout.sessions.create.mockImplementationOnce(async () => {
      const err: any = new Error('The payment method type provided is invalid.');
      err.type = 'StripeInvalidRequestError';
      err.param = 'payment_method_types[1]';
      throw err;
    });
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any);

    expect(mocks.stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(mocks.stripeMock.checkout.sessions.create.mock.calls[0][0].payment_method_types).toEqual([
      'card',
      'klarna',
    ]);
    expect(mocks.stripeMock.checkout.sessions.create.mock.calls[1][0].payment_method_types).toEqual([
      'card',
    ]);
    expect(res.checkoutUrl).toBe('https://checkout.stripe.com/test');
  });

  it('lets any OTHER Stripe failure surface instead of retrying it card-only', async () => {
    // A bad key or an unreachable Stripe would fail identically on the
    // retry, and swallowing it would hide the real cause behind a second
    // copy of itself.
    const ctx = buildDbMock({
      docs: {
        ...invoiceDocs,
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 },
        'business_settings/business_settings': { paymentOptions: { klarna: { enabled: true } } },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.checkout.sessions.create.mockImplementationOnce(async () => {
      const err: any = new Error('Invalid API Key provided.');
      err.type = 'StripeAuthenticationError';
      throw err;
    });
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(payInvoiceHandler({ data: payData, auth: { uid: 'u1' } } as any)).rejects.toThrow(
      /Invalid API Key/,
    );
    expect(mocks.stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });
});
/**
 * ISSUE #826: the settlement round, and reusing a session instead of minting a
 * new one on every call.
 *
 * `payInvoice` charges nothing itself — it hands back a Stripe-hosted URL — so
 * nothing here can refuse a duplicate charge. Two things it CAN do: stamp the
 * round the webhook refuses stale sessions on, and stop handing out a second
 * session when the invoice already has one open.
 */
describe('payInvoice checkout round and session reuse (issue #826)', () => {
  const baseDocs = {
    'clients/u1': { kinfolkIds: ['3'] },
    'families/3/members/u1': PRIMARY_MEMBER,
  };
  const args = { invoiceId: 'inv-1', successUrl: 'https://x/ok', cancelUrl: 'https://x/cancel' };
  /** An open session Stripe would hand back for this invoice at this balance. */
  function openSession(over: Record<string, unknown> = {}) {
    return {
      id: 'cs_open_1',
      url: 'https://checkout.stripe.com/open',
      status: 'open',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      amount_total: 1250,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata: { invoiceId: 'inv-1', checkoutRound: '0' },
      ...over,
    };
  }
  it('stamps the round on BOTH metadata copies, because the webhook may read either', async () => {
    const ctx = buildDbMock({
      docs: { ...baseDocs, 'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5, stripeCheckoutRound: 2 } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    const callArg = mocks.stripeMock.checkout.sessions.create.mock.calls[0][0];
    // A string, because Stripe metadata values are strings.
    expect(callArg.metadata.checkoutRound).toBe('2');
    expect(callArg.payment_intent_data?.metadata?.checkoutRound).toBe('2');
  });
  it('stamps round 0 on an invoice that has never taken a Stripe payment', async () => {
    const ctx = buildDbMock({
      docs: { ...baseDocs, 'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.create.mock.calls[0][0].metadata.checkoutRound).toBe('0');
  });
  it('hands back the session this invoice already has open instead of minting a second', async () => {
    // Defence in depth, NOT the fix: the same session means the same
    // PaymentIntent, which the webhook's existing per-intent ledger already
    // dedupes. It keeps the ordinary two-taps case from ever reaching the
    // invoice-level refusal.
    const ctx = buildDbMock({
      docs: {
        ...baseDocs,
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5, pendingCheckoutSessionId: 'cs_open_1' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.checkout.sessions.retrieve.mockResolvedValueOnce(openSession());
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_open_1');
    expect(mocks.stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(res.sessionId).toBe('cs_open_1');
    expect(res.checkoutUrl).toBe('https://checkout.stripe.com/open');
  });
  it.each([
    ['the session is already complete', { status: 'complete', url: null }],
    ['the session has expired', { status: 'expired', url: null }],
    ['it expires within the minute', { expires_at: Math.floor(Date.now() / 1000) + 30 }],
    ['it charges a stale amount', { amount_total: 5000 }],
    ['it would return to a different screen', { success_url: 'https://other/ok' }],
    ['it would cancel to a different screen', { cancel_url: 'https://other/cancel' }],
    ['it belongs to a settlement round that has closed', { metadata: { invoiceId: 'inv-1', checkoutRound: '1' } }],
    ['it belongs to a different invoice', { metadata: { invoiceId: 'inv-9', checkoutRound: '0' } }],
  ])('mints a fresh session when %s', async (_why, over) => {
    const ctx = buildDbMock({
      docs: {
        ...baseDocs,
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5, pendingCheckoutSessionId: 'cs_open_1' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.checkout.sessions.retrieve.mockResolvedValueOnce(openSession(over));
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(res.sessionId).toBe('cs_test_1');
  });
  it('mints a fresh session when the stored id cannot be read at all', async () => {
    // Fail-soft, and it has to be: a household must never be unable to pay a
    // bill because a stale id could not be inspected. `retrieve` rejects by
    // default in this suite, which is exactly this case.
    const ctx = buildDbMock({
      docs: {
        ...baseDocs,
        'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5, pendingCheckoutSessionId: 'cs_gone' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_gone');
    expect(res.sessionId).toBe('cs_test_1');
  });
  it('does not call Stripe at all when the invoice has no pending session', async () => {
    const ctx = buildDbMock({
      docs: { ...baseDocs, 'invoices/inv-1': { kinfolkId: '3', amountDue: 12.5 } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });
});
