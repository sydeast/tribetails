import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessState } from './activeTribe';
import { BOOKING_HORIZON_DAYS, bookingHorizonEnd, dateKey } from './bookingWizardLogic';
import { queryClient } from './queryClient';

/**
 * #1282: the portal warm-up. Everything below runs against the real
 * `lib/fns.ts` and the real api modules, with only the Functions SDK and the
 * session plumbing faked, so the assertions are about what actually goes on the
 * wire: which callables, with which payloads, under which cache keys.
 */

vi.mock('./firebase', () => ({ functions: {}, auth: { currentUser: null } }));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn() }));

const session = vi.hoisted(() => ({ reactToCallableError: vi.fn(), noteSessionAlive: vi.fn() }));
vi.mock('./revokedSession', () => session);

/** A hand-driven access store standing in for `lib/activeTribe.ts`. */
const store = vi.hoisted(() => ({
  state: null as AccessState | null,
  listeners: new Set<() => void>(),
  auth: { status: 'signedIn', user: { uid: 'u1' } } as { status: 'signedIn' | 'signedOut'; user?: { uid: string } },
}));
vi.mock('./activeTribe', () => ({
  getAccessState: () => store.state,
  subscribeAccess: (listener: () => void) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
}));
vi.mock('./auth', () => ({ getAuthState: () => store.auth }));

/** The fake backend: one function answering every callable by name. */
const server = vi.hoisted(() => ({
  respond: vi.fn<(name: string, payload: unknown) => Promise<unknown>>(),
}));

import { getMyInvoices } from '../api/invoicesApi';
import { installPortalWarmup, portalWarmupInFlight, resetPortalWarmupForTest } from './portalWarmup';
import { myInvoicesKey } from './portalQueryKeys';
import { warmPortalScreens } from './portalWarmupReads';

const ANSWERS: Record<string, unknown> = {
  getMyHome: { displayName: 'The Ruiz Tribe', billingAccess: true },
  getMyAccount: { displayName: 'Sam Ruiz', impersonated: false },
  getBreeds: { dogBreeds: ['Beagle'], catBreeds: ['Siamese'] },
};

function access(overrides: Partial<AccessState>): AccessState {
  return { kinfolkIds: ['k1'], isOperator: false, activeKinfolkId: 'k1', error: null, ...overrides };
}

/** Puts [state] in the store and tells the listeners, as `activeTribe.ts` would. */
function publish(state: AccessState | null): void {
  store.state = state;
  for (const l of store.listeners) l();
}

async function settle(): Promise<void> {
  await (portalWarmupInFlight() ?? Promise.resolve());
}

function calledNames(): string[] {
  return server.respond.mock.calls.map(([name]) => name);
}

function payloadOf(name: string): unknown {
  return server.respond.mock.calls.find(([n]) => n === name)?.[1];
}

function cachedKeys(): string[] {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((q) => JSON.stringify(q.queryKey))
    .sort();
}

/** The keys the screens read under, spelled out so a rename on either side fails here. */
const SCREEN_KEYS = [
  ['myHome', 'k1'],
  ['myAccount', 'k1'],
  ['formSchema', 'account'],
  ['notificationCatalog'],
  ['myNotificationPrefs'],
  ['tribeProfile', 'k1'],
  ['formSchema', 'tribeProfile'],
  ['formSchema', 'homeAccess'],
  ['businessContact'],
  ['members', 'k1'],
  ['serviceCatalog', 'k1'],
  ['businessClosures'],
  ['bookingPolicy'],
  ['myVisits', 'k1'],
  ['myKinPhotos', 'tribe-hub', 'k1'],
  ['breeds'],
];
const MONEY_KEYS = [
  ['myInvoices', 'k1'],
  ['accountCreditHistory', 'k1'],
  ['myPaymentMethod', 'k1'],
];
const MONEY_CALLABLES = ['getMyInvoices', 'getAccountCreditHistory', 'getMyPaymentMethod'];

const sortedJson = (keys: unknown[][]) => keys.map((k) => JSON.stringify(k)).sort();

beforeEach(() => {
  // No screen mounts in these tests, so nothing to yield to: the ceiling is 0.
  // The ordering itself is pinned under 'the opened screen goes first'.
  resetPortalWarmupForTest({ maxWaitMs: 0 });
  queryClient.clear();
  store.state = null;
  store.listeners.clear();
  store.auth = { status: 'signedIn', user: { uid: 'u1' } };
  server.respond.mockImplementation((name) => Promise.resolve(ANSWERS[name] ?? {}));
  vi.mocked(httpsCallable).mockImplementation(
    ((_fns: unknown, name: string) => (payload: unknown) => server.respond(name, payload).then((data) => ({ data }))) as never,
  );
  installPortalWarmup();
});

describe('when the warm-up fires', () => {
  it('fires nothing before access resolves, on a failed access, or without an active tribe', async () => {
    publish(null);
    publish(access({ activeKinfolkId: null })); // an operator still on the picker
    publish(access({ error: 'Could not load your tribes.' }));
    store.auth = { status: 'signedOut' };
    publish(access({}));
    await settle();
    expect(calledNames()).toEqual([]);
    expect(portalWarmupInFlight()).toBeNull();
  });

  it('fires once per tribe per session, and again after access is cleared', async () => {
    publish(access({}));
    await settle();
    publish(access({})); // the next route guard resolving the same access
    await settle();
    expect(calledNames().filter((n) => n === 'getMyHome')).toHaveLength(1);

    publish(null); // sign-out purge (which also clears the query cache)
    queryClient.clear();
    publish(access({}));
    await settle();
    expect(calledNames().filter((n) => n === 'getMyHome')).toHaveLength(2);
  });

  it('warms the newly picked tribe when an operator switches', async () => {
    publish(access({ isOperator: true, kinfolkIds: ['k1', 'k2'] }));
    await settle();
    publish(access({ isOperator: true, kinfolkIds: ['k1', 'k2'], activeKinfolkId: 'k2' }));
    await settle();
    const homes = server.respond.mock.calls.filter(([n]) => n === 'getMyHome').map(([, p]) => p);
    expect(homes).toEqual([{ kinfolkId: 'k1' }, { kinfolkId: 'k2' }]);
  });

  it('is installed once: a second install returns the same teardown', () => {
    const first = installPortalWarmup();
    const second = installPortalWarmup();
    expect(second).toBe(first);
    expect(store.listeners.size).toBe(1);
  });
});

describe('what the warm-up reads', () => {
  it('fills every screen key, spelled exactly as the screen reads it', async () => {
    publish(access({}));
    await settle();
    expect(cachedKeys()).toEqual(sortedJson([...SCREEN_KEYS, ...MONEY_KEYS]));
    expect(queryClient.getQueryData(['myHome', 'k1'])).toEqual(ANSWERS['getMyHome']);
    // Decoded the way the Add Kin editor decodes it, not the raw wire shape.
    expect(queryClient.getQueryData(['breeds'])).toEqual({ dogBreeds: ['Beagle'], catBreeds: ['Siamese'] });
  });

  it('attaches the household id and the screens’ page sizes and date range', async () => {
    publish(access({}));
    await settle();
    const today = new Date();
    expect(payloadOf('getMyVisits')).toEqual({ kinfolkId: 'k1', limit: 20 });
    expect(payloadOf('getMyKinPhotos')).toEqual({ kinfolkId: 'k1', limit: 12 });
    expect(payloadOf('getBusinessClosures')).toEqual({
      fromDate: dateKey(today),
      toDate: dateKey(bookingHorizonEnd(today, BOOKING_HORIZON_DAYS)),
    });
    expect(payloadOf('getMyTribeProfile')).toEqual({ kinfolkId: 'k1' });
    expect(payloadOf('listMembers')).toEqual({ kinfolkId: 'k1' });
    expect(payloadOf('getServiceCatalog')).toEqual({ kinfolkId: 'k1' });
    expect(payloadOf('getMyAccount')).toEqual({ kinfolkId: 'k1' });
  });

  it('leaves a read alone that a screen already holds fresh', async () => {
    queryClient.setQueryData(['myHome', 'k1'], { displayName: 'cached', billingAccess: true });
    publish(access({}));
    await settle();
    expect(calledNames()).not.toContain('getMyHome');
    // The cached answer still gates the money reads.
    expect(calledNames()).toContain('getMyInvoices');
  });
});

describe('the money gate (#1005)', () => {
  it('fires the three money reads, household attached, when the home payload grants billing access', async () => {
    publish(access({}));
    await settle();
    for (const name of MONEY_CALLABLES) expect(payloadOf(name)).toEqual({ kinfolkId: 'k1' });
  });

  it('skips the money reads when the home payload says no billing access', async () => {
    server.respond.mockImplementation((name) =>
      Promise.resolve(name === 'getMyHome' ? { displayName: 'The Ruiz Tribe', billingAccess: false } : (ANSWERS[name] ?? {})),
    );
    publish(access({}));
    await settle();
    for (const name of MONEY_CALLABLES) expect(calledNames()).not.toContain(name);
    expect(cachedKeys()).toEqual(sortedJson(SCREEN_KEYS));
  });

  it('warms no money at all when the home read failed, rather than guess', async () => {
    server.respond.mockImplementation((name) =>
      name === 'getMyHome' ? Promise.reject(new FirebaseError('functions/internal', 'cold')) : Promise.resolve(ANSWERS[name] ?? {}),
    );
    publish(access({}));
    await settle();
    for (const name of MONEY_CALLABLES) expect(calledNames()).not.toContain(name);
    expect(calledNames()).toContain('getMyTribeProfile');
  });

  it('skips the payment method, but not the invoices, for an operator stepping into a household', async () => {
    server.respond.mockImplementation((name) =>
      Promise.resolve(name === 'getMyAccount' ? { displayName: 'Op', impersonated: true } : (ANSWERS[name] ?? {})),
    );
    publish(access({ isOperator: true }));
    await settle();
    expect(calledNames()).toContain('getMyInvoices');
    expect(calledNames()).toContain('getAccountCreditHistory');
    expect(calledNames()).not.toContain('getMyPaymentMethod');
  });
});

describe('silence', () => {
  const revoked = new FirebaseError('functions/unauthenticated', 'Your session was ended (session-revoked). Sign in again.');

  it('a refused read does not throw, does not reach the sign-out reaction, and leaves no error in the cache', async () => {
    server.respond.mockImplementation((name) =>
      name === 'getMyInvoices' ? Promise.reject(revoked) : Promise.resolve(ANSWERS[name] ?? {}),
    );
    publish(access({}));
    await expect(settle()).resolves.toBeUndefined();

    expect(session.reactToCallableError).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(['myInvoices', 'k1'])).toBeUndefined();
    // Everything else still landed.
    expect(cachedKeys()).toEqual(sortedJson([...SCREEN_KEYS, ...MONEY_KEYS].filter((k) => k[0] !== 'myInvoices')));
  });

  it('warmPortalScreens itself never rejects, even when every read fails', async () => {
    server.respond.mockImplementation(() => Promise.reject(new FirebaseError('functions/deadline-exceeded', 'slow')));
    await expect(warmPortalScreens('k1')).resolves.toBeUndefined();
    expect(session.reactToCallableError).not.toHaveBeenCalled();
    expect(cachedKeys()).toEqual([]);
  });

  it('does not retry a failed read on its own', async () => {
    server.respond.mockImplementation((name) =>
      name === 'getBusinessContact' ? Promise.reject(new FirebaseError('functions/internal', 'cold')) : Promise.resolve(ANSWERS[name] ?? {}),
    );
    publish(access({}));
    await settle();
    expect(calledNames().filter((n) => n === 'getBusinessContact')).toHaveLength(1);
  });

  it('the listener never throws into the access store', () => {
    server.respond.mockImplementation(() => {
      throw new Error('synchronous failure');
    });
    expect(() => publish(access({}))).not.toThrow();
  });
});

describe('the opened screen goes first (#1561)', () => {
  /** A promise the test resolves by hand: the screen's read, still on the wire. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  /** Mounts what `InvoiceDetail` mounts first: `getMyInvoices` under the shared key, through the real api module. */
  function mountInvoiceScreen(): () => void {
    const observer = new QueryObserver(queryClient, {
      queryKey: myInvoicesKey('k1'),
      queryFn: () => getMyInvoices('k1'),
    });
    return observer.subscribe(() => undefined);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetPortalWarmupForTest({ quietMs: 150, maxWaitMs: 10_000 });
    installPortalWarmup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on a deep link, the route’s read is issued before any warm-up read, and the warm-up runs once it settles', async () => {
    const invoices = deferred<unknown>();
    server.respond.mockImplementation((name) =>
      name === 'getMyInvoices' ? invoices.promise : Promise.resolve(ANSWERS[name] ?? {}),
    );

    // The route guard resolves access before the screen chunk has loaded.
    publish(access({}));
    await vi.advanceTimersByTimeAsync(500); // the chunk loading
    expect(calledNames()).toEqual([]);

    const unmount = mountInvoiceScreen();
    await vi.advanceTimersByTimeAsync(5_000); // a slow cold start on the screen's own read
    expect(calledNames()).toEqual(['getMyInvoices']);

    invoices.resolve([]);
    await vi.advanceTimersByTimeAsync(149);
    expect(calledNames()).toEqual(['getMyInvoices']); // still inside the quiet window

    await vi.advanceTimersByTimeAsync(1);
    await settle();

    const names = calledNames();
    expect(names[0]).toBe('getMyInvoices');
    expect(names).toContain('getMyHome');
    expect(names).toContain('getMyTribeProfile');
    expect(names).toContain('getAccountCreditHistory'); // the money gate still opens
    // The read the screen just made is not fired a second time.
    expect(names.filter((n) => n === 'getMyInvoices')).toHaveLength(1);
    unmount();
  });

  it('still warms after the ceiling when the route’s read hangs', async () => {
    server.respond.mockImplementation((name) =>
      name === 'getMyInvoices' ? new Promise(() => undefined) : Promise.resolve(ANSWERS[name] ?? {}),
    );
    publish(access({}));
    const unmount = mountInvoiceScreen();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calledNames()).toEqual(['getMyInvoices']);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(calledNames()).toContain('getMyHome');
    expect(calledNames()).toContain('getBreeds');
    expect(calledNames().filter((n) => n === 'getMyInvoices')).toHaveLength(1);
    unmount();
  });

  it('still warms after the ceiling when no screen ever mounts a query', async () => {
    publish(access({}));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calledNames()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(calledNames()).toContain('getMyHome');
  });

  it('warms nothing for a tribe that was signed out of during the wait', async () => {
    publish(access({}));
    await vi.advanceTimersByTimeAsync(1_000);

    publish(null);
    queryClient.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(calledNames()).toEqual([]);
  });
});
