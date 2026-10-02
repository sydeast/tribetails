import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/stripe', () => ({
  getStripe: () => {
    throw new Error('the test passes its own sessions api');
  },
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__TS__', arrayUnion: (...v: unknown[]) => ({ union: v }) },
  };
});
import { retryInvoiceCheckoutCloseHandler } from '../src/admin/retryInvoiceCheckoutClose';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import type { CheckoutSessionsApi } from '../src/lib/checkoutSweepRun';
beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});
function req(data: unknown, uid: string | null = 'admin1', token: Record<string, unknown> = { admin: true }) {
  return {
    data,
    auth: uid ? ({ uid, token } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}
function stripe(statuses: Record<string, string>, expireFails: Record<string, string> = {}): CheckoutSessionsApi {
  const state = { ...statuses };
  return {
    retrieve: vi.fn(async (id: string) => ({ id, status: state[id] })),
    expire: vi.fn(async (id: string) => {
      if (expireFails[id]) throw new Error(expireFails[id]);
      state[id] = 'expired';
      return {};
    }),
  };
}
const STUCK = {
  kinfolkId: 'fam1',
  invoiceNumber: 'INV-9',
  status: 'paid',
  amountDue: 0,
  total: 40,
  openCheckoutSessionIds: ['cs_a', 'cs_b'],
  closedCheckoutSessionIds: ['cs_a'],
  checkoutSweep: { failed: [{ sessionId: 'cs_b', reason: 'Stripe is down.' }] },
};
function seed(invoice: Record<string, unknown> | null) {
  return buildDbMock({ docs: { 'invoices/inv1': invoice } });
}
describe('retryInvoiceCheckoutClose', () => {
  it('expires the sessions still open and records the outcome on the invoice', async () => {
    const ctx = seed(STUCK);
    mocks.dbFn.mockReturnValue(ctx.db);
    const api = stripe({ cs_b: 'open' });
    const res = await retryInvoiceCheckoutCloseHandler(req({ invoiceId: 'inv1' }), { sessions: async () => api });
    expect(res).toEqual({ ok: true, invoiceId: 'inv1', closedCount: 1, failedCount: 0 });
    expect(api.expire).toHaveBeenCalledWith('cs_b');
    expect(api.expire).not.toHaveBeenCalledWith('cs_a'); // already on the closed list
    const w = ctx.writes.find((x) => x.path === 'invoices/inv1')! as any;
    expect(w.data.checkoutSweep.failed).toEqual([]);
    expect(w.data.checkoutSweep.expiredIds).toEqual({ union: ['cs_b'] });
    expect(w.data.closedCheckoutSessionIds).toEqual({ union: ['cs_b'] });
  });
  it("keeps Stripe's plain error when it still fails, and reports it", async () => {
    const ctx = seed(STUCK);
    mocks.dbFn.mockReturnValue(ctx.db);
    const api = stripe({ cs_b: 'open' }, { cs_b: 'Stripe is still down.' });
    const res = await retryInvoiceCheckoutCloseHandler(req({ invoiceId: 'inv1' }), { sessions: async () => api });
    expect(res).toMatchObject({ closedCount: 0, failedCount: 1 });
    const w = ctx.writes.find((x) => x.path === 'invoices/inv1')! as any;
    expect(w.data.checkoutSweep.failed).toEqual([{ sessionId: 'cs_b', reason: 'Stripe is still down.' }]);
    expect(w.data.closedCheckoutSessionIds).toBeUndefined();
  });
  it('audits the retry like other admin writes', async () => {
    const ctx = seed(STUCK);
    mocks.dbFn.mockReturnValue(ctx.db);
    await retryInvoiceCheckoutCloseHandler(req({ invoiceId: 'inv1' }), { sessions: async () => stripe({ cs_b: 'open' }) });
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_CHECKOUT_CLOSE_RETRIED',
        actorUid: 'admin1',
        targetUid: 'inv1',
        targetCollection: 'invoices',
        familyId: 'fam1',
        payload: expect.objectContaining({ invoiceId: 'inv1', closed: 1, failed: 0 }),
      }),
    );
  });
  it('does nothing, and does not touch Stripe, when nothing is left to close', async () => {
    const ctx = seed({ ...STUCK, closedCheckoutSessionIds: ['cs_a', 'cs_b'], checkoutSweep: { failed: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const api = stripe({});
    const res = await retryInvoiceCheckoutCloseHandler(req({ invoiceId: 'inv1' }), { sessions: async () => api });
    expect(res).toEqual({ ok: true, invoiceId: 'inv1', closedCount: 0, failedCount: 0 });
    expect(api.retrieve).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
  it('refuses an invoice that is not paid: those links are how the household pays', async () => {
    const ctx = seed({ ...STUCK, status: 'open', amountDue: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    const api = stripe({ cs_b: 'open' });
    await expect(
      retryInvoiceCheckoutCloseHandler(req({ invoiceId: 'inv1' }), { sessions: async () => api }),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_not_paid' } });
    expect(api.expire).not.toHaveBeenCalled();
  });
  it('404s a missing invoice and rejects a bad argument', async () => {
    mocks.dbFn.mockReturnValue(seed(null).db);
    await expect(retryInvoiceCheckoutCloseHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'not-found' });
    await expect(retryInvoiceCheckoutCloseHandler(req({}))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('records one plain reason when Stripe cannot be reached at all', async () => {
    const ctx = seed(STUCK);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await retryInvoiceCheckoutCloseHandler(req({ invoiceId: 'inv1' }), {
      sessions: async () => {
        throw new Error('STRIPE_SECRET_KEY environment variable is required');
      },
    });
    expect(res.failedCount).toBe(1);
    const w = ctx.writes.find((x) => x.path === 'invoices/inv1')! as any;
    expect(w.data.checkoutSweep.failed[0].reason).toBe('Stripe could not be reached from the server.');
  });
  it('is behind the staff gate: a signed-out or non-admin caller is refused', async () => {
    const wrapped = wrapAdminCallable('retryInvoiceCheckoutClose', retryInvoiceCheckoutCloseHandler as any);
    await expect(wrapped(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(wrapped(req({ invoiceId: 'inv1' }, 'kinfolk1', {}))).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
