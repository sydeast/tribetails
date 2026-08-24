import type { RevocationCheck } from '../../src/lib/sessionRevocation';

/**
 * Stand-in for `src/lib/sessionRevocation` in tests that drive a handler
 * THROUGH `wrapCallable`/`wrapAdminCallable` to assert something else.
 *
 * The real module's #557 check calls `auth().getUser(uid)`, which is a live
 * Identity Toolkit round trip. Those suites are about admin gating, audit
 * entries and handler behavior, and none of them should acquire a network
 * dependency to keep passing. The check's own behavior is pinned in
 * `test/sessionRevocation.test.ts`, and the fact that `wrapCallable` calls it
 * at all is pinned in `test/wrapCallable.test.ts` — neither of which mocks it
 * away.
 *
 * Use as a one-liner:
 *   vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
 */
export async function assertSessionNotRevoked(): Promise<RevocationCheck> {
  return { outcome: 'skipped', durationMs: 0 };
}

export function forgetSession(): void {
  // no-op
}

export function resetSessionRevocationCacheForTest(): void {
  // no-op
}

export const REVOKED_REASON = 'session-revoked';
export const DISABLED_REASON = 'user-disabled';
export const REVOKED_MESSAGE = `Your session was ended (${REVOKED_REASON}). Sign in again.`;
export const DISABLED_MESSAGE = `This account is turned off (${DISABLED_REASON}). Contact Auntie.`;
