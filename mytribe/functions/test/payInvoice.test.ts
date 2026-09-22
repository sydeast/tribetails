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

/**
 * Stripe's SECOND argument: per-request options, where its own idempotency
 * lives (issue #825). Declared for the same reason `CheckoutSessionParams` is:
 * an untyped mock records a one-arg call signature and `mock.calls[0][1]`
 * reads as `undefined` no matter what the handler passed.
 */
interface StripeRequestOptions {
  idempotencyKey?: string;
}
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  stripeMock: {
    checkout: {
      sessions: {
        create: vi.fn(async (_params: CheckoutSessionParams, _options?: StripeRequestOptions) => ({
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

  /**
   * #902: THE PAY BUTTON HAS TO LEAD SOMEWHERE.
   *
   * A migrated invoice carries a `total` and no balance at all. This handler
   * used to read that as $0 and refuse — invisible while the portal showed the
   * same bill as $0.00 with no Pay button, and a dead end the moment
   * `getMyInvoices` started shipping the derived balance. It asks the shared
   * rule now, so the screen and the checkout charge the same figure.
   */
  it('#902: charges a migrated invoice its derived balance instead of refusing it', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-legacy': { kinfolkId: '3', status: 'sent', total: 40 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({
      data: { invoiceId: 'inv-legacy', successUrl: 'https://x', cancelUrl: 'https://y' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.checkoutUrl).toContain('checkout.stripe.com');
    expect(res.amountCents).toBe(4000);
    const callArg = mocks.stripeMock.checkout.sessions.create.mock.calls[0]![0];
    expect(callArg.line_items[0]!.price_data.unit_amount).toBe(4000);
  });

  /**
   * AND IT MUST NOT CHARGE ONE TWICE. There are no refunds, so the one thing
   * this path may never do is take a card payment for a bill already settled.
   * The rows are the only record that a migrated bill was paid off before
   * `amountDue` existed, so this handler reads them for that shape and for no
   * other, and refuses when they cover the total.
   */
  it('#902: refuses a migrated invoice its own payment rows already cover', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-legacy-paid': { kinfolkId: '3', status: 'sent', total: 40 },
      },
      queryDocs: { 'invoices/inv-legacy-paid/payments': [{ id: 'p1', data: { amountCents: 4000, amount: 40 } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await expect(
      payInvoiceHandler({
        data: { invoiceId: 'inv-legacy-paid', successUrl: 'https://x', cancelUrl: 'https://y' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mocks.stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('#902: charges only the remainder when those rows fall short', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'invoices/inv-legacy-part': { kinfolkId: '3', status: 'sent', total: 40 },
      },
      queryDocs: { 'invoices/inv-legacy-part/payments': [{ id: 'p1', data: { amountCents: 1500, amount: 15 } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({
      data: { invoiceId: 'inv-legacy-part', successUrl: 'https://x', cancelUrl: 'https://y' },
      auth: { uid: 'u1' },
    } as any);
    const callArg = mocks.stripeMock.checkout.sessions.create.mock.calls[0]![0];
    expect(callArg.line_items[0]!.price_data.unit_amount).toBe(2500);
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
/**
 * #825 meets #826: the Stripe request-option key and the session reuse are
 * layers, not rivals, and they must not be able to disagree.
 *
 * The reuse can only hand back a session it can FIND, through the
 * `pendingCheckoutSessionId` written AFTER Stripe returns. It therefore covers
 * the call that finished. The key covers the call that did not: Stripe made the
 * session, the reply was lost, nothing was stored, and the retry would
 * otherwise mint a second live checkout.
 *
 * Where they could have fought is the BODY. Stripe refuses a key reused with
 * different parameters, and #826 deliberately mints fresh when the amount or
 * the round has moved. So the key handed to Stripe carries both of those, which
 * makes the two rules turn on the same facts.
 */
describe('payInvoice Stripe idempotency key (#825) against the #826 reuse', () => {
  const baseDocs = {
    'clients/u1': { kinfolkIds: ['3'] },
    'families/3/members/u1': PRIMARY_MEMBER,
  };
  const args = {
    invoiceId: 'inv-1',
    successUrl: 'https://x/ok',
    cancelUrl: 'https://x/cancel',
    idempotencyKey: 'chk_1757700000000_ab12cd',
  };
  const invoice = (over: Record<string, unknown> = {}) => ({
    kinfolkId: '3',
    amountDue: 12.5,
    ...over,
  });

  /** Runs one call and hands back the key that actually reached Stripe. */
  async function mint(docs: Record<string, unknown>, data: Record<string, unknown> = args) {
    const ctx = buildDbMock({ docs: { ...baseDocs, ...docs } as any });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data, auth: { uid: 'u1' } } as any);
    return mocks.stripeMock.checkout.sessions.create.mock.calls[0][1]?.idempotencyKey;
  }

  it('sends no request options at all when the caller supplied no key', async () => {
    const key = await mint({ 'invoices/inv-1': invoice() }, {
      invoiceId: 'inv-1',
      successUrl: 'https://x/ok',
      cancelUrl: 'https://x/cancel',
    });
    expect(key).toBeUndefined();
  });

  it('derives the Stripe key from the caller key, the round and the amount', async () => {
    const key = await mint({ 'invoices/inv-1': invoice({ stripeCheckoutRound: 2 }) });
    expect(key).toBe('chk_1757700000000_ab12cd_r2_1250');
  });

  it('sends the SAME Stripe key for a retry of one submission at one balance', async () => {
    // The whole point. Two attempts, nothing changed in between, so Stripe
    // replays the first session instead of opening a second live checkout.
    const first = await mint({ 'invoices/inv-1': invoice() });
    mocks.stripeMock.checkout.sessions.create.mockClear();
    const second = await mint({ 'invoices/inv-1': invoice() });
    expect(second).toBe(first);
  });

  it('sends a DIFFERENT Stripe key once the balance has moved', async () => {
    // #826 mints a fresh session when the amount no longer matches. If the key
    // did not move with it, Stripe would refuse the changed body and a
    // household would be unable to pay a bill they are trying to settle. This
    // is the case a partial Venmo payment between two taps produces.
    const before = await mint({ 'invoices/inv-1': invoice() });
    mocks.stripeMock.checkout.sessions.create.mockClear();
    const after = await mint({ 'invoices/inv-1': invoice({ amountDue: 7.5 }) });
    expect(after).not.toBe(before);
    expect(after).toBe('chk_1757700000000_ab12cd_r0_750');
  });

  it('sends a DIFFERENT Stripe key once the settlement round has closed', async () => {
    const before = await mint({ 'invoices/inv-1': invoice() });
    mocks.stripeMock.checkout.sessions.create.mockClear();
    const after = await mint({ 'invoices/inv-1': invoice({ stripeCheckoutRound: 1 }) });
    expect(after).not.toBe(before);
  });

  it('gives the card-only fallback its own key, because it sends a different body', async () => {
    const ctx = buildDbMock({
      docs: {
        ...baseDocs,
        'invoices/inv-1': invoice(),
        'business_settings/business_settings': { paymentOptions: { klarna: { enabled: true } } },
      } as any,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.checkout.sessions.create.mockImplementationOnce(async () => {
      const err: any = new Error('The payment method type provided is invalid.');
      err.type = 'StripeInvalidRequestError';
      err.param = 'payment_method_types[1]';
      throw err;
    });
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    const calls = mocks.stripeMock.checkout.sessions.create.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]?.idempotencyKey).toBe('chk_1757700000000_ab12cd_r0_1250');
    // Not the same key with a smaller method list: Stripe would refuse that,
    // and the graceful fallback would become a hard error on a bill somebody
    // is trying to settle.
    expect(calls[1][1]?.idempotencyKey).toBe('chk_1757700000000_ab12cd_r0_1250_card');
  });

  it('never reaches Stripe at all when the reuse answers first', async () => {
    // Layer order: the reuse runs BEFORE the create, so a session that can be
    // handed back costs no Stripe write and consumes no key.
    const ctx = buildDbMock({
      docs: {
        ...baseDocs,
        'invoices/inv-1': invoice({ pendingCheckoutSessionId: 'cs_open_1' }),
      } as any,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.stripeMock.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: 'cs_open_1',
      url: 'https://checkout.stripe.com/open',
      status: 'open',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      amount_total: 1250,
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata: { invoiceId: 'inv-1', checkoutRound: '0' },
    });
    const { payInvoiceHandler } = await import('../src/portal/payInvoice');
    const res = await payInvoiceHandler({ data: args, auth: { uid: 'u1' } } as any);
    expect(mocks.stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    expect(res.sessionId).toBe('cs_open_1');
  });
});

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
