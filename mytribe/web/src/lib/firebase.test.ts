// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, initializeAppCheck } from 'firebase/app-check';
import { reportError } from './sentry';

/**
 * Issue #556, second half: once App Check can actually activate, a failed
 * attestation has to be distinguishable from a session that never attempted
 * one. `initializeAppCheck` returns synchronously and reports nothing, so
 * "activated" on its own is not evidence — the first token is.
 */

vi.mock('firebase/app', () => ({ initializeApp: vi.fn().mockReturnValue({ name: '[DEFAULT]' }) }));
vi.mock('firebase/auth', () => ({ getAuth: vi.fn().mockReturnValue({}) }));
vi.mock('firebase/firestore', () => ({ getFirestore: vi.fn().mockReturnValue({}) }));
vi.mock('firebase/functions', () => ({ getFunctions: vi.fn().mockReturnValue({}) }));
vi.mock('./sentry', () => ({ reportError: vi.fn(), initSentry: vi.fn() }));
vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn().mockReturnValue({ appCheck: true }),
  getToken: vi.fn().mockResolvedValue({ token: 'attestation-token' }),
  ReCaptchaEnterpriseProvider: vi.fn(),
}));

describe('activateAppCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(initializeAppCheck).mockReturnValue({ appCheck: true } as never);
    vi.mocked(getToken).mockResolvedValue({ token: 'attestation-token' } as never);
  });

  afterEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  it('starts inactive: nothing attests until something asks it to', async () => {
    const { getAppCheckStatus } = await import('./firebase');
    expect(getAppCheckStatus()).toBe('inactive');
    expect(vi.mocked(initializeAppCheck)).not.toHaveBeenCalled();
  });

  it('reaches active only once a real token has been minted', async () => {
    const { activateAppCheck, getAppCheckStatus } = await import('./firebase');

    activateAppCheck();

    // Activated, but nothing has attested yet — this is the state the old code
    // treated as success.
    expect(getAppCheckStatus()).toBe('pending');
    await vi.waitFor(() => expect(getAppCheckStatus()).toBe('active'));
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });

  it('initializes App Check once however many times the auth listener fires', async () => {
    const { activateAppCheck } = await import('./firebase');

    activateAppCheck();
    activateAppCheck();
    activateAppCheck();

    expect(vi.mocked(initializeAppCheck)).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected attestation instead of passing silently', async () => {
    const boom = new Error('reCAPTCHA Enterprise: invalid site key');
    vi.mocked(getToken).mockRejectedValue(boom);
    const { activateAppCheck, getAppCheckStatus } = await import('./firebase');

    activateAppCheck();

    await vi.waitFor(() => expect(getAppCheckStatus()).toBe('failed'));
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(boom, 'appCheck');
  });

  it('reports an activation that throws, and does not retry into the same wall', async () => {
    const boom = new Error('App Check is not registered for this app');
    vi.mocked(initializeAppCheck).mockImplementation(() => {
      throw boom;
    });
    const { activateAppCheck, getAppCheckStatus } = await import('./firebase');

    activateAppCheck();
    activateAppCheck();

    expect(getAppCheckStatus()).toBe('failed');
    expect(vi.mocked(initializeAppCheck)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(boom, 'appCheck');
  });

  it('calls a token that never arrives a failure rather than waiting forever', async () => {
    vi.useFakeTimers();
    vi.mocked(getToken).mockReturnValue(new Promise(() => undefined) as never);
    const { activateAppCheck, getAppCheckStatus } = await import('./firebase');

    activateAppCheck();
    expect(getAppCheckStatus()).toBe('pending');

    // The pend is the failure mode that stalls every callable before the
    // network. It has to end in an error, not in silence.
    await vi.advanceTimersByTimeAsync(25_000);

    expect(getAppCheckStatus()).toBe('failed');
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(expect.any(Error), 'appCheck');
  });
});
