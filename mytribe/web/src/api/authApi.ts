/**
 * Session-lifetime callables. Typed wrapper over the `signOutAllDevices`
 * function that has existed in `functions/src/auth/signOutAllDevices.ts` since
 * it was written and, until #539, had no caller in any client.
 */
import { call } from '../lib/fns';

/**
 * Revokes every refresh token issued to the signed-in account.
 *
 * WHAT THIS BUYS. Firebase's client-side `signOut()` is purely local: it drops
 * the persisted user from this browser and nothing else. The refresh token it
 * discards remains valid server-side, so a copy of it lifted from another
 * device — or from this one's storage before the sign-out — keeps minting
 * fresh ID tokens indefinitely. `revokeRefreshTokens` is what actually ends
 * the session on the server.
 *
 * WHAT IT DOES NOT BUY, stated plainly so nobody over-trusts it. Already-minted
 * ID tokens stay valid until they expire (up to an hour), because
 * `onCall` verifies signature and expiry without `checkRevoked`. Revocation
 * stops the session being RENEWED; it does not retire tokens already in flight.
 *
 * IT IS ALL DEVICES, NOT THIS ONE. Firebase Auth has no per-device revoke —
 * `revokeRefreshTokens` is uid-scoped. Signing out on the laptop therefore ends
 * the phone's session too. For a kinfolk portal that is the safer default (the
 * shared-device case is the one sign-out exists for), but it is a real
 * behaviour, not an implementation detail.
 *
 * BEST EFFORT, ALWAYS. The caller must never let this block the local
 * sign-out: a kinfolk on a borrowed laptop with no signal still has to be able
 * to get out of their account. See `lib/auth.ts`'s `signOut`.
 */
export function signOutAllDevices(): Promise<{ ok: true }> {
  return call<Record<string, never>, { ok: true }>('signOutAllDevices', {});
}

/**
 * #886: tells the backend a sign-in failed on a credential error, so it can
 * count failures, warn the household at 5 and lock the account at 10.
 *
 * Unauthenticated by design: the person has just failed to sign in. The server
 * answers `{ ok: true }` for every email, real or not, so the result carries no
 * information and nothing here reads it. `lib/auth.ts` fires it and forgets it.
 */
export function reportFailedLogin(email: string): Promise<{ ok: true }> {
  return call<{ email: string }, { ok: true }>('recordFailedLogin', { email });
}
