import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #454. The walk showed six consecutive securetoken refresh failures inside one
 * 13-second window, then a success — and not one line anywhere saying so. These
 * tests are the observer that was missing: they drive a refresh that rejects and
 * assert the session says so, retries, and clears itself when the network comes
 * back.
 */

const { onAuthStateChanged } = vi.hoisted(() => ({ onAuthStateChanged: vi.fn() }));
const { authStub } = vi.hoisted(() => ({
  authStub: { currentUser: null as null | { getIdToken: (force?: boolean) => Promise<string> } },
}));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock('firebase/auth', () => ({ onAuthStateChanged }));
vi.mock('./firebase', () => ({ auth: authStub }));
vi.mock('./sentry', () => ({ reportError }));

import {
  PROBE_INTERVAL_MS,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  classifyRefreshFailure,
  getSessionHealth,
  resetSessionHealthForTest,
  retryDelayMs,
} from './sessionHealth';

/**
 * The listener sessionHealth.ts registered at import time.
 *
 * Captured once, right here, instead of read from `onAuthStateChanged.mock.calls`
 * on every call: vitest 5's default `clearMocks: true` wipes a mock's call
 * history before each test, but sessionHealth.ts registers this listener
 * exactly once, at module import -- long before any test's `beforeEach` runs.
 * A per-test helper reading `.mock.calls[0]` only ever worked because a
 * repo-wide `clearMocks: false` pin kept that first call around; grabbing the
 * real function once, into a plain closure variable, needs nothing to survive
 * between tests.
 */
const registeredAuthListener = ((): ((user: unknown) => void) => {
  const call = onAuthStateChanged.mock.calls[0];
  if (!call) throw new Error('sessionHealth registered no auth listener');
  return call[1] as (user: unknown) => void;
})();

function authListener(): (user: unknown) => void {
  return registeredAuthListener;
}

function networkError(): Error & { code: string } {
  return Object.assign(new Error('Failed to fetch'), { code: 'auth/network-request-failed' });
}

function otherAuthError(): Error & { code: string } {
  return Object.assign(new Error('nope'), { code: 'auth/internal-error' });
}

/** Signs a user in with the given getIdToken and lets the store settle. */
function signIn(getIdToken: (force?: boolean) => Promise<string>): void {
  authStub.currentUser = { getIdToken };
  authListener()(authStub.currentUser);
}

/** Advances timers and drains the probe's microtasks. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('classifyRefreshFailure', () => {
  it('treats only the SDK network code as worth retrying', () => {
    expect(classifyRefreshFailure(networkError())).toBe('unreachable');
  });

  it('treats any other auth code as needing a fresh sign-in', () => {
    expect(classifyRefreshFailure(otherAuthError())).toBe('expired');
  });

  it('treats a throw with no code at all as needing a fresh sign-in', () => {
    expect(classifyRefreshFailure(new Error('boom'))).toBe('expired');
    expect(classifyRefreshFailure(undefined)).toBe('expired');
  });
});

describe('retryDelayMs', () => {
  it('doubles from the floor and stops at the ceiling', () => {
    expect(retryDelayMs(1)).toBe(RETRY_MIN_MS);
    expect(retryDelayMs(2)).toBe(RETRY_MIN_MS * 2);
    expect(retryDelayMs(3)).toBe(RETRY_MIN_MS * 4);
    expect(retryDelayMs(20)).toBe(RETRY_MAX_MS);
  });

  it('never returns less than the floor', () => {
    expect(retryDelayMs(0)).toBe(RETRY_MIN_MS);
  });
});

describe('the session-health monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSessionHealthForTest();
    reportError.mockClear();
    authStub.currentUser = null;
  });

  afterEach(() => {
    resetSessionHealthForTest();
    vi.useRealTimers();
  });

  it('says nothing while the token still mints', async () => {
    const getIdToken = vi.fn().mockResolvedValue('token');
    signIn(getIdToken);
    expect(getSessionHealth()).toEqual({ status: 'ok' });

    await advance(PROBE_INTERVAL_MS);
    expect(getIdToken).toHaveBeenCalledTimes(1);
    // The cheap call: never a forced refresh, so a healthy session costs no
    // network at all until the cached token is nearly out of time.
    expect(getIdToken).toHaveBeenCalledWith(false);
    expect(getSessionHealth()).toEqual({ status: 'ok' });
  });

  it('reports a refused refresh instead of leaving the operator guessing', async () => {
    signIn(vi.fn().mockRejectedValue(networkError()));

    await advance(PROBE_INTERVAL_MS);

    expect(getSessionHealth()).toEqual({ status: 'unreachable', failures: 1 });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[1]).toBe('sessionHealthUnreachable');
  });

  it('retries on a widening backoff rather than hammering the endpoint', async () => {
    const getIdToken = vi.fn().mockRejectedValue(networkError());
    signIn(getIdToken);

    await advance(PROBE_INTERVAL_MS);
    expect(getIdToken).toHaveBeenCalledTimes(1);

    // Nothing happens a tick before the first retry is due...
    await advance(RETRY_MIN_MS - 1);
    expect(getIdToken).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(getIdToken).toHaveBeenCalledTimes(2);
    expect(getSessionHealth()).toEqual({ status: 'unreachable', failures: 2 });

    // ...and the next gap is twice as long, not the same one again.
    await advance(RETRY_MIN_MS * 2 - 1);
    expect(getIdToken).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getIdToken).toHaveBeenCalledTimes(3);
    expect(getSessionHealth()).toEqual({ status: 'unreachable', failures: 3 });

    // One episode, one Sentry event, however many retries it took.
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('clears itself when the network comes back, like the walk did', async () => {
    // The walk's shape exactly: six refusals, then a 200.
    const getIdToken = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue('token');
    signIn(getIdToken);

    await advance(PROBE_INTERVAL_MS);
    for (let failures = 1; failures <= 5; failures += 1) {
      expect(getSessionHealth()).toEqual({ status: 'unreachable', failures });
      await advance(retryDelayMs(failures));
    }
    expect(getSessionHealth()).toEqual({ status: 'unreachable', failures: 6 });

    await advance(retryDelayMs(6));
    expect(getIdToken).toHaveBeenCalledTimes(7);
    expect(getSessionHealth()).toEqual({ status: 'ok' });
  });

  it('asks for a fresh sign-in when retrying cannot help, and stops probing', async () => {
    const getIdToken = vi.fn().mockRejectedValue(otherAuthError());
    signIn(getIdToken);

    await advance(PROBE_INTERVAL_MS);
    expect(getSessionHealth()).toEqual({ status: 'expired' });
    expect(reportError.mock.calls[0]?.[1]).toBe('sessionHealthExpired');

    await advance(RETRY_MAX_MS * 4);
    expect(getIdToken).toHaveBeenCalledTimes(1);
    expect(getSessionHealth()).toEqual({ status: 'expired' });
  });

  it('forgets a degraded session on sign-out and probes nothing', async () => {
    const getIdToken = vi.fn().mockRejectedValue(networkError());
    signIn(getIdToken);
    await advance(PROBE_INTERVAL_MS);
    expect(getSessionHealth()).toEqual({ status: 'unreachable', failures: 1 });

    authStub.currentUser = null;
    authListener()(null);
    expect(getSessionHealth()).toEqual({ status: 'ok' });

    const before = getIdToken.mock.calls.length;
    await advance(PROBE_INTERVAL_MS * 4);
    expect(getIdToken).toHaveBeenCalledTimes(before);
  });
});
