import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { callableMap } from '../scripts/clientCallables';

/** A signed-in kinfolk request with no App Check token, as Android and desktop send. */
const UNATTESTED = { auth: { uid: 'k1' } } as unknown as CallableRequest<unknown>;

/**
 * #987, end to end through the real wrapper and the REAL cohort (no mock of
 * appCheckPolicy here, unlike wrapCallable.test.ts): with the settings doc still
 * holding the retired `enforce` value (D-2026-09-28-APP-CHECK-ONLY-LOGS),
 * a request with no App Check token, which is every request the Android and
 * desktop clients send, is served for every callable those clients can reach.
 */
const mocks = vi.hoisted(() => ({
  securityDocGet: vi.fn(),
  assertSessionNotRevoked: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn(), initSentry: () => {} }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('a1') }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => ({
  assertSessionNotRevoked: mocks.assertSessionNotRevoked,
  forgetSession: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ collection: () => ({ doc: () => ({ get: mocks.securityDocGet }) }) }),
}));

describe('#987 a leftover enforce setting never refuses an Android or desktop client', () => {
  beforeEach(async () => {
    mocks.securityDocGet.mockResolvedValue({ data: () => ({ appCheckMode: 'enforce' }) });
    mocks.assertSessionNotRevoked.mockResolvedValue({ outcome: 'miss', durationMs: 1 });
    const { resetAppCheckModeCache } = await import('../src/lib/appCheckPolicy');
    resetAppCheckModeCache();
  });

  it('serves a token-less getBusinessClosures call, the Android booking calendar', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const handler = vi.fn().mockResolvedValue({ closures: [] });
    const wrapped = wrapCallable('getBusinessClosures', handler);

    await expect(wrapped(UNATTESTED)).resolves.toEqual({ closures: [] });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('serves a token-less call to every callable a Compose or Android client names', async () => {
    const { wrapCallable } = await import('../src/lib/wrapCallable');
    const reachable = callableMap().unattestedReachable;
    expect(reachable.length).toBeGreaterThan(100);
    for (const name of reachable) {
      const wrapped = wrapCallable(name, async () => ({ ok: true }));
      await expect(wrapped(UNATTESTED), name).resolves.toEqual({ ok: true });
    }
  });
});
