import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  logEvent: vi.fn(),
  capture: vi.fn().mockReturnValue('sentry-id-1'),
}));
const { getUser: getUserMock, logEvent: logEventMock, capture: captureMock } = mocks;

vi.mock('../src/lib/firestoreAdmin', () => ({
  auth: () => ({ getUser: mocks.getUser }),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({
  captureFunctionError: mocks.capture,
  initSentry: () => {},
}));

import {
  assertSessionNotRevoked,
  forgetSession,
  resetSessionRevocationCacheForTest,
  REVOKED_REASON,
  DISABLED_REASON,
} from '../src/lib/sessionRevocation';
import { callableRequest } from './_helpers/callableRequest';

/** Seconds-since-epoch, which is what a real `auth_time` claim carries. */
function authTimeSec(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function signedInAt(uid: string, iso: string) {
  return callableRequest({}, { uid, token: { auth_time: authTimeSec(iso) } });
}

describe('assertSessionNotRevoked (#557)', () => {
  beforeEach(() => {
    resetSessionRevocationCacheForTest();
    getUserMock.mockReset();
    logEventMock.mockClear();
    captureMock.mockClear();
    delete process.env.AUTH_REVOCATION_CACHE_TTL_MS;
  });

  afterEach(() => {
    delete process.env.AUTH_REVOCATION_CACHE_TTL_MS;
    // Restores the Date.now spy the TTL test installs, so a failure there
    // cannot leave a frozen clock behind for everything after it.
    vi.restoreAllMocks();
  });

  it('lets a valid token through on an account that has never been revoked', async () => {
    getUserMock.mockResolvedValue({ disabled: false });
    const check = await assertSessionNotRevoked(signedInAt('u1', '2026-08-24T10:00:00Z'), 'getMyHome');
    expect(check.outcome).toBe('miss');
    expect(getUserMock).toHaveBeenCalledWith('u1');
  });

  it('lets a token minted AFTER the revoke through — the new session is not the revoked one', async () => {
    getUserMock.mockResolvedValue({
      disabled: false,
      tokensValidAfterTime: 'Sun, 24 Aug 2026 10:00:00 GMT',
    });
    await expect(
      assertSessionNotRevoked(signedInAt('u1', '2026-08-24T10:05:00Z'), 'getMyHome'),
    ).resolves.toMatchObject({ outcome: 'miss' });
  });

  it('rejects a token whose sign-in predates tokensValidAfterTime', async () => {
    getUserMock.mockResolvedValue({
      disabled: false,
      tokensValidAfterTime: 'Sun, 24 Aug 2026 10:00:00 GMT',
    });
    await expect(
      assertSessionNotRevoked(signedInAt('u1', '2026-08-24T09:55:00Z'), 'getMyHome'),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      details: { reason: REVOKED_REASON },
    });
  });

  it('carries the reason token in the message too, for clients that cannot read details', async () => {
    getUserMock.mockResolvedValue({
      disabled: false,
      tokensValidAfterTime: 'Sun, 24 Aug 2026 10:00:00 GMT',
    });
    await expect(
      assertSessionNotRevoked(signedInAt('u1', '2026-08-24T09:55:00Z'), 'getMyHome'),
    ).rejects.toMatchObject({ message: expect.stringContaining(REVOKED_REASON) });
  });

  it('rejects a disabled account even when nothing was ever revoked', async () => {
    getUserMock.mockResolvedValue({ disabled: true });
    await expect(
      assertSessionNotRevoked(signedInAt('u1', '2026-08-24T10:00:00Z'), 'getMyHome'),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
      details: { reason: DISABLED_REASON },
    });
  });

  it('treats a missing auth_time as epoch 0 — fail-closed against a revoked account', async () => {
    getUserMock.mockResolvedValue({
      disabled: false,
      tokensValidAfterTime: 'Sun, 24 Aug 2026 10:00:00 GMT',
    });
    await expect(
      assertSessionNotRevoked(callableRequest({}, { uid: 'u1' }), 'getMyHome'),
    ).rejects.toMatchObject({ details: { reason: REVOKED_REASON } });
  });

  it('skips the lookup entirely for an unauthenticated call', async () => {
    const check = await assertSessionNotRevoked(callableRequest({}), 'health');
    expect(check.outcome).toBe('skipped');
    expect(getUserMock).not.toHaveBeenCalled();
  });

  it('collapses a burst of concurrent calls to ONE Identity Toolkit lookup', async () => {
    getUserMock.mockResolvedValue({ disabled: false });
    const req = signedInAt('u1', '2026-08-24T10:00:00Z');
    const checks = await Promise.all([
      assertSessionNotRevoked(req, 'getMyHome'),
      assertSessionNotRevoked(req, 'getMyKin'),
      assertSessionNotRevoked(req, 'getMyInvoices'),
      assertSessionNotRevoked(req, 'getMyNotifications'),
      assertSessionNotRevoked(req, 'getFeatureFlags'),
    ]);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    // The first arrival owns the lookup; the rest ride its in-flight promise.
    expect(checks.filter((c) => c.outcome === 'miss')).toHaveLength(1);
    expect(checks.filter((c) => c.outcome === 'hit')).toHaveLength(4);
  });

  it('re-reads after the TTL lapses, so a revoke lands within the window', async () => {
    process.env.AUTH_REVOCATION_CACHE_TTL_MS = '5000';
    getUserMock.mockResolvedValue({ disabled: false });
    const req = signedInAt('u1', '2026-08-24T10:00:00Z');
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    await assertSessionNotRevoked(req, 'getMyHome');
    await assertSessionNotRevoked(req, 'getMyHome');
    expect(getUserMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 5001);
    getUserMock.mockResolvedValue({
      disabled: false,
      tokensValidAfterTime: 'Sun, 24 Aug 2026 10:30:00 GMT',
    });
    await expect(assertSessionNotRevoked(req, 'getMyHome')).rejects.toMatchObject({
      details: { reason: REVOKED_REASON },
    });
    expect(getUserMock).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockRestore();
  });

  it('AUTH_REVOCATION_CACHE_TTL_MS=0 disables caching for an exact check', async () => {
    process.env.AUTH_REVOCATION_CACHE_TTL_MS = '0';
    getUserMock.mockResolvedValue({ disabled: false });
    const req = signedInAt('u1', '2026-08-24T10:00:00Z');
    await assertSessionNotRevoked(req, 'getMyHome');
    await assertSessionNotRevoked(req, 'getMyHome');
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it('fails OPEN when the lookup itself errors, and says so in the logs', async () => {
    getUserMock.mockRejectedValue(new Error('identitytoolkit unavailable'));
    const check = await assertSessionNotRevoked(signedInAt('u1', '2026-08-24T10:00:00Z'), 'getMyHome');
    expect(check.outcome).toBe('error');
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth.revocationCheck.unavailable', uid: 'u1' }),
    );
    expect(captureMock).toHaveBeenCalled();
  });

  it('does not poison the cache with a failed lookup — the next call retries', async () => {
    getUserMock.mockRejectedValueOnce(new Error('identitytoolkit unavailable'));
    getUserMock.mockResolvedValue({
      disabled: false,
      tokensValidAfterTime: 'Sun, 24 Aug 2026 10:00:00 GMT',
    });
    const req = signedInAt('u1', '2026-08-24T09:55:00Z');
    await expect(assertSessionNotRevoked(req, 'getMyHome')).resolves.toMatchObject({ outcome: 'error' });
    await expect(assertSessionNotRevoked(req, 'getMyHome')).rejects.toMatchObject({
      details: { reason: REVOKED_REASON },
    });
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it('forgetSession drops this instance’s cached answer', async () => {
    getUserMock.mockResolvedValue({ disabled: false });
    const req = signedInAt('u1', '2026-08-24T10:00:00Z');
    await assertSessionNotRevoked(req, 'getMyHome');
    forgetSession('u1');
    await assertSessionNotRevoked(req, 'getMyHome');
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it('caches per uid, not globally', async () => {
    getUserMock.mockResolvedValue({ disabled: false });
    await assertSessionNotRevoked(signedInAt('u1', '2026-08-24T10:00:00Z'), 'getMyHome');
    await assertSessionNotRevoked(signedInAt('u2', '2026-08-24T10:00:00Z'), 'getMyHome');
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });
});
