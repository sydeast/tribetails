import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * Card management for the portal Billing Details card (#399 item 3).
 *
 * The gate under test is the one that does NOT exist anywhere else in the
 * portal: every card write lands on `clients/{uid}`, the CALLER's own doc, so
 * unlike a read callable this one must refuse a household the caller does not
 * personally belong to even when they hold the admin claim. An operator who
 * stepped into a household through the tribe picker would otherwise attach a
 * card to their own account under the household's name.
 */

interface CheckoutSessionParams {
  mode: string;
  customer: string;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, string>;
  [key: string]: unknown;
}

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  stripeMock: {
    customers: {
      create: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'cus_new' })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async (_params: CheckoutSessionParams) => ({
          id: 'cs_setup_1',
          url: 'https://checkout.stripe.com/setup',
        })),
      },
    },
    paymentMethods: {
      list: vi.fn(async (_params: Record<string, unknown>) => ({
        data: [
          { id: 'pm_new', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } },
        ],
      })),
      detach: vi.fn(async (_id: string) => ({ id: _id })),
    },
  },
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/stripe', () => ({ getStripe: async () => mocks.stripeMock }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' },
  };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.stripeMock.customers.create.mockClear();
  mocks.stripeMock.checkout.sessions.create.mockClear();
  mocks.stripeMock.paymentMethods.list.mockClear();
  mocks.stripeMock.paymentMethods.detach.mockClear();
  mocks.stripeMock.paymentMethods.list.mockResolvedValue({
    data: [{ id: 'pm_new', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } }],
  });
  mocks.stripeMock.paymentMethods.detach.mockImplementation(async (id: string) => ({ id }));
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };
const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: { billing_full: false, kintales_only: true },
};

/** A household whose primary has already saved a card. */
function withStoredCard() {
  return buildDbMock({
    docs: {
      'clients/u1': {
        kinfolkIds: ['f1'],
        email: 'kin@example.com',
        displayName: 'Rosa',
        stripeCustomerId: 'cus_existing',
        stripePaymentMethodId: 'pm_old',
        stripeCardBrand: 'visa',
        stripeCardLast4: '1111',
        stripeCardExpMonth: 9,
        stripeCardExpYear: 2029,
      },
      'families/f1/members/u1': PRIMARY_MEMBER,
    },
  });
}

/** A household that has never opened the card flow. */
function withNoCard() {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['f1'], email: 'kin@example.com', displayName: 'Rosa' },
      'families/f1/members/u1': PRIMARY_MEMBER,
    },
  });
}

describe('getMyPaymentMethodHandler', () => {
  it('rejects an unauthenticated caller', async () => {
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(getMyPaymentMethodHandler(callableRequest({}))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('describes the card on file', async () => {
    mocks.dbFn.mockReturnValue(withStoredCard().db);
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await getMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.hasPaymentMethod).toBe(true);
    expect(res.card).toEqual({ brand: 'visa', last4: '1111', expMonth: 9, expYear: 2029 });
  });

  it('reports no card when nothing is stored', async () => {
    mocks.dbFn.mockReturnValue(withNoCard().db);
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await getMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res).toEqual({ hasPaymentMethod: false, card: null, updatedAtMs: null });
  });

  it('describes no card when the display fields are half-written', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['f1'], stripePaymentMethodId: 'pm_x', stripeCardBrand: 'visa' },
        'families/f1/members/u1': PRIMARY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await getMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.hasPaymentMethod).toBe(true);
    expect(res.card).toBeNull();
  });

  it('refuses an account with no tribe linked', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'clients/u1': { kinfolkIds: [] } } }).db);
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(getMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it("denies a household that is not the caller's own", async () => {
    mocks.dbFn.mockReturnValue(withStoredCard().db);
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(
      getMyPaymentMethodHandler(callableRequest({ kinfolkId: 'OTHER' }, { uid: 'u1' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('denies an OPERATOR reading a household they do not belong to (impersonation)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = buildDbMock({
      docs: { 'clients/op-uid': { kinfolkIds: ['own-family'] }, 'kinfolk/f1': { name: 'Other' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(
      getMyPaymentMethodHandler(
        callableRequest({ kinfolkId: 'f1' }, { uid: 'op-uid', token: { admin: true } }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('denies a kintales-only secondary', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u2': { kinfolkIds: ['f1'] },
        'families/f1/members/u2': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(getMyPaymentMethodHandler(callableRequest({}, { uid: 'u2' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('createBillingSetupSessionHandler', () => {
  const URLS = { successUrl: 'https://kinfolk.example/account?billing=saved', cancelUrl: 'https://kinfolk.example/account' };

  it('rejects an unauthenticated caller', async () => {
    const { createBillingSetupSessionHandler } = await import('../src/portal/billing');
    await expect(createBillingSetupSessionHandler(callableRequest(URLS))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('rejects a success URL that is not a URL', async () => {
    mocks.dbFn.mockReturnValue(withNoCard().db);
    const { createBillingSetupSessionHandler } = await import('../src/portal/billing');
    await expect(
      createBillingSetupSessionHandler(
        callableRequest({ successUrl: 'not a url', cancelUrl: URLS.cancelUrl }, { uid: 'u1' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mocks.stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('creates a Stripe customer on first use and remembers its id', async () => {
    const ctx = withNoCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createBillingSetupSessionHandler } = await import('../src/portal/billing');
    const res = await createBillingSetupSessionHandler(callableRequest(URLS, { uid: 'u1' }));

    expect(res).toEqual({ checkoutUrl: 'https://checkout.stripe.com/setup', sessionId: 'cs_setup_1' });
    expect(mocks.stripeMock.customers.create).toHaveBeenCalledTimes(1);
    const customerArgs = mocks.stripeMock.customers.create.mock.calls[0][0];
    expect(customerArgs['email']).toBe('kin@example.com');
    expect(customerArgs['metadata']).toMatchObject({ uid: 'u1', familyId: 'f1' });

    const write = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(write?.data?.['stripeCustomerId']).toBe('cus_new');

    const session = mocks.stripeMock.checkout.sessions.create.mock.calls[0][0];
    expect(session.mode).toBe('setup');
    expect(session.customer).toBe('cus_new');
    expect(session.metadata['purpose']).toBe('save-card');
    expect(session.metadata['uid']).toBe('u1');
  });

  it('reuses the stored customer instead of creating a second one', async () => {
    mocks.dbFn.mockReturnValue(withStoredCard().db);
    const { createBillingSetupSessionHandler } = await import('../src/portal/billing');
    await createBillingSetupSessionHandler(callableRequest(URLS, { uid: 'u1' }));
    expect(mocks.stripeMock.customers.create).not.toHaveBeenCalled();
    expect(mocks.stripeMock.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_existing');
  });

  it('denies a kintales-only secondary and opens no session', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u2': { kinfolkIds: ['f1'] },
        'families/f1/members/u2': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { createBillingSetupSessionHandler } = await import('../src/portal/billing');
    await expect(createBillingSetupSessionHandler(callableRequest(URLS, { uid: 'u2' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mocks.stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe('syncMyPaymentMethodHandler', () => {
  it('is a no-op for a household that never opened the card flow', async () => {
    mocks.dbFn.mockReturnValue(withNoCard().db);
    const { syncMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await syncMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res).toEqual({ hasPaymentMethod: false, card: null, updatedAtMs: null, changed: false });
    expect(mocks.stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });

  it('stores the card Stripe reports and says it changed', async () => {
    const ctx = withStoredCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { syncMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await syncMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));

    expect(res.hasPaymentMethod).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.card).toEqual({ brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 });
    const write = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(write?.data?.['stripePaymentMethodId']).toBe('pm_new');
    expect(write?.data?.['stripeCardLast4']).toBe('4242');
  });

  it('reports changed=false when Stripe still holds the stored card', async () => {
    mocks.stripeMock.paymentMethods.list.mockResolvedValue({
      data: [{ id: 'pm_old', card: { brand: 'visa', last4: '1111', exp_month: 9, exp_year: 2029 } }],
    });
    mocks.dbFn.mockReturnValue(withStoredCard().db);
    const { syncMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await syncMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.changed).toBe(false);
    expect(res.hasPaymentMethod).toBe(true);
  });

  it('clears the local mirror when Stripe holds no card any more', async () => {
    mocks.stripeMock.paymentMethods.list.mockResolvedValue({ data: [] });
    const ctx = withStoredCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { syncMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await syncMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res).toEqual({ hasPaymentMethod: false, card: null, updatedAtMs: null, changed: true });
    const write = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(write?.data?.['stripePaymentMethodId']).toBe('__DELETE__');
  });

  it("denies a household that is not the caller's own", async () => {
    mocks.dbFn.mockReturnValue(withStoredCard().db);
    const { syncMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(
      syncMyPaymentMethodHandler(callableRequest({ kinfolkId: 'OTHER' }, { uid: 'u1' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('removeMyPaymentMethodHandler', () => {
  it('is a no-op when there is no card on file', async () => {
    mocks.dbFn.mockReturnValue(withNoCard().db);
    const { removeMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await removeMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res).toEqual({ ok: true, alreadyEmpty: true });
    expect(mocks.stripeMock.paymentMethods.detach).not.toHaveBeenCalled();
  });

  it('detaches at Stripe and clears the stored card', async () => {
    const ctx = withStoredCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await removeMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res).toEqual({ ok: true, alreadyEmpty: false });
    expect(mocks.stripeMock.paymentMethods.detach).toHaveBeenCalledWith('pm_old');
    const write = ctx.writes.find((w) => w.path === 'clients/u1');
    expect(write?.data?.['stripePaymentMethodId']).toBe('__DELETE__');
    expect(write?.data?.['stripeCardBrand']).toBe('__DELETE__');
  });

  it('still clears the mirror when Stripe says the card is already gone', async () => {
    mocks.stripeMock.paymentMethods.detach.mockRejectedValue(
      Object.assign(new Error('No such PaymentMethod'), { code: 'resource_missing' }),
    );
    const ctx = withStoredCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeMyPaymentMethodHandler } = await import('../src/portal/billing');
    const res = await removeMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }));
    expect(res.alreadyEmpty).toBe(false);
    expect(ctx.writes.find((w) => w.path === 'clients/u1')?.data?.['stripePaymentMethodId']).toBe('__DELETE__');
  });

  it('reports a real Stripe outage as unavailable and keeps the card', async () => {
    mocks.stripeMock.paymentMethods.detach.mockRejectedValue(
      Object.assign(new Error('connection error'), { code: 'api_connection_error' }),
    );
    const ctx = withStoredCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { removeMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(removeMyPaymentMethodHandler(callableRequest({}, { uid: 'u1' }))).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(ctx.writes.find((w) => w.path === 'clients/u1')).toBeUndefined();
  });

  it('rejects an unauthenticated caller', async () => {
    const { removeMyPaymentMethodHandler } = await import('../src/portal/billing');
    await expect(removeMyPaymentMethodHandler(callableRequest({}))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});

describe('stripeWebhook setup-session branch', () => {
  const setupEvent = (metadata: Record<string, string>, customer: unknown = 'cus_existing') => ({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_setup_1', mode: 'setup', customer, metadata } },
  });

  it('recognises a card-save session and ignores an invoice payment session', async () => {
    const { isSetupSessionEvent } = await import('../src/billing/stripeSetupSession');
    expect(isSetupSessionEvent(setupEvent({ purpose: 'save-card', uid: 'u1' }))).toBe(true);
    expect(
      isSetupSessionEvent({
        id: 'evt_2',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_pay', mode: 'payment', metadata: { invoiceId: 'inv-1' } } },
      }),
    ).toBe(false);
    expect(
      isSetupSessionEvent({ id: 'evt_3', type: 'payment_intent.succeeded', data: { object: {} } }),
    ).toBe(false);
  });

  it('mirrors the saved card onto the household account', async () => {
    const ctx = withNoCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { handleSetupSessionCompleted } = await import('../src/billing/stripeSetupSession');
    const code = await handleSetupSessionCompleted(setupEvent({ purpose: 'save-card', uid: 'u1' }));
    expect(code).toBe(200);
    expect(ctx.writes.find((w) => w.path === 'clients/u1')?.data?.['stripePaymentMethodId']).toBe('pm_new');
  });

  it('answers 202 and writes nothing when the session names no uid', async () => {
    const ctx = withNoCard();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { handleSetupSessionCompleted } = await import('../src/billing/stripeSetupSession');
    const code = await handleSetupSessionCompleted(setupEvent({ purpose: 'save-card' }));
    expect(code).toBe(202);
    expect(ctx.writes).toHaveLength(0);
  });

  it('answers 202 when the account named by the session no longer exists', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { handleSetupSessionCompleted } = await import('../src/billing/stripeSetupSession');
    const code = await handleSetupSessionCompleted(setupEvent({ purpose: 'save-card', uid: 'ghost' }));
    expect(code).toBe(202);
    expect(mocks.stripeMock.paymentMethods.list).not.toHaveBeenCalled();
  });
});
