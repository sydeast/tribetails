import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  set: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/stripe', () => ({
  getStripe: () => {
    throw new Error('the test passes its own sessions api');
  },
}));

import { FieldValue } from 'firebase-admin/firestore';
import {
  CLOSED_CHECKOUT_SESSIONS_FIELD,
  OPEN_CHECKOUT_SESSIONS_FIELD,
  sessionsToClose,
} from '../src/lib/checkoutSessionSweep';
import {
  closeCheckoutSession,
  onInvoicePaidExpireCheckoutsHandler,
  type CheckoutSessionsApi,
} from '../src/triggers/onInvoicePaidExpireCheckouts';

/**
 * Docket Q5 (operator ruling 2026-09-27): once an invoice is paid, every
 * Checkout Session still open for it is expired at Stripe, so a household with
 * a tab open cannot pay a settled bill.
 */

beforeEach(() => {
  mocks.set.mockReset().mockResolvedValue(undefined);
  mocks.logEvent.mockReset();
  mocks.dbFn.mockReset().mockReturnValue({
    collection: () => ({ doc: () => ({ set: mocks.set }) }),
  });
});

function event(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  return {
    params: { invoiceId: 'inv1' },
    data: { before: { data: () => before }, after: { data: () => after } },
  } as any;
}

/** A Stripe stand-in: sessions by id, with the status Stripe would report. */
function fakeStripe(statuses: Record<string, string | 'missing'>, opts: { expireFails?: string[] } = {}) {
  const state = { ...statuses };
  const api: CheckoutSessionsApi = {
    retrieve: vi.fn(async (id: string) => {
      if (state[id] === undefined || state[id] === 'missing') {
        throw Object.assign(new Error('No such checkout.session'), { code: 'resource_missing' });
      }
      return { id, status: state[id] };
    }),
    expire: vi.fn(async (id: string) => {
      if (opts.expireFails?.includes(id)) throw new Error('stripe unavailable');
      if (state[id] !== 'open') throw new Error('Only open sessions can be expired');
      state[id] = 'expired';
      return { id, status: 'expired' };
    }),
  };
  return { api, state };
}

describe('sessionsToClose (pure)', () => {
  it('lists nothing while the invoice is unpaid: those sessions are how the household pays', () => {
    expect(
      sessionsToClose(undefined, { status: 'open', amountDue: 40, total: 40, [OPEN_CHECKOUT_SESSIONS_FIELD]: ['cs_1'] }),
    ).toEqual([]);
  });

  it('lists every minted session once the invoice is paid, plus the pending id the paid write deleted', () => {
    const before = { status: 'open', amountDue: 40, total: 40, pendingCheckoutSessionId: 'cs_2', [OPEN_CHECKOUT_SESSIONS_FIELD]: ['cs_1', 'cs_2'] };
    const after = { status: 'paid', amountDue: 0, total: 40, [OPEN_CHECKOUT_SESSIONS_FIELD]: ['cs_1', 'cs_2'] };
    expect(sessionsToClose(before, after)).toEqual(['cs_1', 'cs_2']);
  });

  it('covers a session minted before the list existed (pending id only)', () => {
    const before = { amountDue: 40, total: 40, pendingCheckoutSessionId: 'cs_legacy' };
    expect(sessionsToClose(before, { status: 'paid', amountDue: 0, total: 40 })).toEqual(['cs_legacy']);
  });

  it('skips ids already closed, which is what makes a re-fire a no-op', () => {
    const after = {
      status: 'paid',
      amountDue: 0,
      total: 40,
      [OPEN_CHECKOUT_SESSIONS_FIELD]: ['cs_1', 'cs_2'],
      [CLOSED_CHECKOUT_SESSIONS_FIELD]: ['cs_1', 'cs_2'],
    };
    expect(sessionsToClose(after, after)).toEqual([]);
  });

  it('treats an invoice marked paid with a stale positive balance as paid', () => {
    expect(
      sessionsToClose(undefined, { status: 'paid', amountDue: 40, total: 137.5, pendingCheckoutSessionId: 'cs_9' }),
    ).toEqual(['cs_9']);
  });

  it('a deleted invoice closes nothing', () => {
    expect(sessionsToClose({ status: 'paid', pendingCheckoutSessionId: 'cs_1' }, undefined)).toEqual([]);
  });
});

describe('closeCheckoutSession', () => {
  it('expires an open session', async () => {
    const { api, state } = fakeStripe({ cs_1: 'open' });
    expect(await closeCheckoutSession(api, 'cs_1')).toBe('expired');
    expect(state.cs_1).toBe('expired');
  });

  it('leaves a completed or expired session alone', async () => {
    const { api } = fakeStripe({ cs_done: 'complete', cs_old: 'expired' });
    expect(await closeCheckoutSession(api, 'cs_done')).toBe('already-closed');
    expect(await closeCheckoutSession(api, 'cs_old')).toBe('already-closed');
    expect(api.expire).not.toHaveBeenCalled();
  });

  it('a session Stripe does not know is closed', async () => {
    const { api } = fakeStripe({});
    expect(await closeCheckoutSession(api, 'cs_gone')).toBe('not-found');
  });

  it('a household finishing checkout between the read and the expire is not a failure', async () => {
    // Stripe refuses to expire a session that just completed. The charge is the
    // race the webhook records as unapplied; this sweep just has nothing left.
    const { api, state } = fakeStripe({ cs_1: 'open' });
    (api.expire as any).mockImplementationOnce(async () => {
      state.cs_1 = 'complete';
      throw new Error('Only open sessions can be expired');
    });
    expect(await closeCheckoutSession(api, 'cs_1')).toBe('already-closed');
  });

  it('reports a real failure on a session that is still open', async () => {
    const { api } = fakeStripe({ cs_1: 'open' }, { expireFails: ['cs_1'] });
    expect(await closeCheckoutSession(api, 'cs_1')).toBe('failed');
  });
});

describe('onInvoicePaidExpireCheckoutsHandler', () => {
  const paidAfter = {
    status: 'paid',
    amountDue: 0,
    total: 40,
    [OPEN_CHECKOUT_SESSIONS_FIELD]: ['cs_web', 'cs_android', 'cs_paid'],
  };
  const openBefore = { ...paidAfter, status: 'open', amountDue: 40, pendingCheckoutSessionId: 'cs_paid' };

  it('expires every open session when the invoice becomes paid, and records them closed', async () => {
    const { api, state } = fakeStripe({ cs_web: 'open', cs_android: 'open', cs_paid: 'complete' });
    await onInvoicePaidExpireCheckoutsHandler(event(openBefore, paidAfter), { sessions: async () => api });

    expect(state).toEqual({ cs_web: 'expired', cs_android: 'expired', cs_paid: 'complete' });
    expect(mocks.set).toHaveBeenCalledTimes(1);
    const [data, opts] = mocks.set.mock.calls[0]!;
    expect(data[CLOSED_CHECKOUT_SESSIONS_FIELD]).toEqual(FieldValue.arrayUnion('cs_web', 'cs_android', 'cs_paid'));
    expect(opts).toEqual({ merge: true });
  });

  it('is idempotent: the re-fire from its own write calls Stripe for nothing', async () => {
    const { api } = fakeStripe({});
    const closed = { ...paidAfter, [CLOSED_CHECKOUT_SESSIONS_FIELD]: ['cs_web', 'cs_android', 'cs_paid'] };
    await onInvoicePaidExpireCheckoutsHandler(event(paidAfter, closed), { sessions: async () => api });
    expect(api.retrieve).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('does nothing on an unpaid invoice', async () => {
    const { api } = fakeStripe({ cs_web: 'open' });
    await onInvoicePaidExpireCheckoutsHandler(event(undefined, openBefore), { sessions: async () => api });
    expect(api.retrieve).not.toHaveBeenCalled();
  });

  it('leaves a failed session off the closed list so the next write retries it, and logs at error', async () => {
    const { api } = fakeStripe({ cs_web: 'open', cs_android: 'open', cs_paid: 'complete' }, { expireFails: ['cs_android'] });
    await onInvoicePaidExpireCheckoutsHandler(event(openBefore, paidAfter), { sessions: async () => api });
    const [data] = mocks.set.mock.calls[0]!;
    expect(data[CLOSED_CHECKOUT_SESSIONS_FIELD]).toEqual(FieldValue.arrayUnion('cs_web', 'cs_paid'));
    const partial = mocks.logEvent.mock.calls.find((c) => c[0]?.event === 'stripe.checkout.sweep.partial');
    expect(partial![0].severity).toBe('error');
  });

  it('never throws when Stripe cannot be reached at all', async () => {
    await expect(
      onInvoicePaidExpireCheckoutsHandler(event(openBefore, paidAfter), {
        sessions: async () => {
          throw new Error('STRIPE_SECRET_KEY environment variable is required');
        },
      }),
    ).resolves.toBeUndefined();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.logEvent.mock.calls.some((c) => c[0]?.event === 'stripe.checkout.sweep.unavailable')).toBe(true);
  });

  it('binds the Stripe key, which the other two invoice triggers do not hold', async () => {
    const mod = await import('../src/triggers/onInvoicePaidExpireCheckouts');
    const endpoint = (mod.onInvoicePaidExpireCheckouts as any).__endpoint;
    const keys = (endpoint?.secretEnvironmentVariables ?? []).map((s: { key: string }) => s.key);
    expect(keys).toContain('STRIPE_SECRET_KEY');
  });
});
