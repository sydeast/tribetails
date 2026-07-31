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
});
