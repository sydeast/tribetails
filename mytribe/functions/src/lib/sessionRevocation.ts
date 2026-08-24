import { HttpsError } from 'firebase-functions/v2/https';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { auth } from './firestoreAdmin';
import { logEvent } from './logger';
import { captureFunctionError } from './sentry';

/**
 * Session-revocation enforcement for every authenticated callable (#557).
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS CLOSES
 * ---------------------------------------------------------------------------
 * `onCall` populates `req.auth` from the platform's own `verifyIdToken(token)`
 * — signature, issuer, audience, expiry. It does NOT pass `checkRevoked: true`,
 * and there is no option to make it. So an ID token minted a moment before the
 * kinfolk signed out (or before an operator disabled the account) keeps being
 * accepted for the rest of its natural hour.
 *
 * #539 wired `signOutAllDevices` into sign-out, which revokes the REFRESH
 * token: the session can no longer be renewed. That closes the long window —
 * a refresh token is good for months. This file closes the short one.
 *
 * ---------------------------------------------------------------------------
 * WHAT "REVOKED" MEANS HERE
 * ---------------------------------------------------------------------------
 * Identical to what `verifyIdToken(token, true)` does internally: look the user
 * record up and compare the token's `auth_time` against the account's
 * `tokensValidAfterTime` (the `validSince` stamp that `revokeRefreshTokens`
 * writes). A token whose sign-in predates that stamp belongs to a session that
 * has been ended. The same lookup answers `disabled`, so a disabled account is
 * refused in the same round trip rather than needing a second one.
 *
 * Note that Firebase moves `tokensValidAfterTime` on a password change and a
 * password reset too, not just on an explicit revoke. That is intended: after
 * "change my password", the sessions on other devices should stop working, and
 * from this commit on they stop within seconds instead of within an hour.
 *
 * ---------------------------------------------------------------------------
 * THE POLICY, AND WHY (this is the "decide the policy" the issue asked for)
 * ---------------------------------------------------------------------------
 * 1. ENFORCED ON EVERY AUTHENTICATED CALLABLE, not on a hand-maintained list of
 *    "sensitive" ones. A list would need a rule for which side of the line each
 *    new callable lands on, and that rule would be wrong within a month: what
 *    is sensitive is a property of the data, and nearly every portal callable
 *    reads a household's data. One gate that always runs beats 269 judgement
 *    calls. `wrapCallable` is the single call site (`wrapAdminCallable`
 *    delegates to it), so this is one line of enforcement, not 269.
 *
 * 2. FAIL-OPEN ON A FAILED LOOKUP, FAIL-CLOSED ON A DEFINITE ANSWER. If the
 *    Identity Toolkit lookup itself errors — quota, an outage, a cold instance
 *    with no network yet — we log it, report it, and let the call through.
 *    Refusing instead would turn a dependency blip into a total outage of all
 *    269 functions, caused by a hardening measure. Failing open during such a
 *    blip degrades exactly back to the pre-#557 behavior (a revoked token lives
 *    out its hour), which is a bounded, already-accepted risk. A definite
 *    "revoked" or "disabled" answer is always enforced.
 *
 * 3. A SHORT TTL CACHE, NOT AN EXACT CHECK. See the cost section below.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS, AND WHAT THE CACHE BUYS
 * ---------------------------------------------------------------------------
 * The uncached check is one Admin SDK `getUser` — an `accounts:lookup` HTTPS
 * round trip to Identity Toolkit — on every authenticated invocation, plus the
 * matching Identity Platform quota. Across a fleet this size that is the real
 * decision, and it is why #557 was split out of #539 rather than folded in.
 *
 * Two things keep it off the hot path:
 *
 *  - IN-FLIGHT COALESCING. The promise, not the result, is what goes in the
 *    map. A screen that fires eight callables at once therefore issues ONE
 *    lookup and the other seven await it. A rejected lookup is evicted
 *    immediately, so one failure cannot poison a uid for the rest of the TTL.
 *
 *  - A 5 SECOND TTL. Long enough to collapse a burst (a portal screen load
 *    settles well inside it), short enough that the residual window is 5
 *    seconds rather than 3600. That is the honest statement of what this
 *    change buys: the window is not closed to zero, it goes from up to an hour
 *    to at most `AUTH_REVOCATION_CACHE_TTL_MS`, per instance.
 *
 * Both are per-instance memory, so the effective rate is one lookup per uid per
 * TTL per warm instance. `AUTH_REVOCATION_CACHE_TTL_MS=0` disables the cache
 * for an exact check at full cost; there is no env var that disables the check.
 *
 * `wrapCallable` logs `authCheckMs` and `authCheck` (`hit` / `miss` / `error` /
 * `skipped` / `revoked`) on every invocation, which is how the real cost gets
 * measured in production instead of guessed at here.
 */

/** Machine-readable `details.reason` the clients branch on. */
export const REVOKED_REASON = 'session-revoked';
export const DISABLED_REASON = 'user-disabled';

/**
 * The reason token is repeated in the message on purpose. `details.reason` is
 * the clean signal and the web portal reads it, but the Android/KMP clients
 * cross three Firebase SDK layers whose `details` typing differs per platform,
 * and message text is the one field every one of them carries through intact
 * (same reason `GalleryController.isPermissionDenied` matches on text). Keep
 * the tokens in both places or the Android reaction goes deaf.
 */
export const REVOKED_MESSAGE = `Your session was ended (${REVOKED_REASON}). Sign in again.`;
export const DISABLED_MESSAGE = `This account is turned off (${DISABLED_REASON}). Contact Auntie.`;

const DEFAULT_TTL_MS = 5_000;

function ttlMs(): number {
  const raw = process.env.AUTH_REVOCATION_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

interface SessionFacts {
  /** `tokensValidAfterTime` as epoch ms, or 0 when the account has never been revoked. */
  validSinceMs: number;
  disabled: boolean;
}

interface CacheEntry {
  expiresAt: number;
  inflight: Promise<SessionFacts>;
}

const cache = new Map<string, CacheEntry>();

async function fetchSessionFacts(uid: string): Promise<SessionFacts> {
  const user = await auth().getUser(uid);
  const validSince = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : NaN;
  return {
    validSinceMs: Number.isFinite(validSince) ? validSince : 0,
    disabled: user.disabled === true,
  };
}

/**
 * Cached + coalesced read of the account facts that decide revocation.
 * `cached` is the hit/miss half of the cost telemetry.
 */
function sessionFacts(uid: string, now = Date.now()): { facts: Promise<SessionFacts>; cached: boolean } {
  const ttl = ttlMs();
  const existing = cache.get(uid);
  if (existing && existing.expiresAt > now) {
    return { facts: existing.inflight, cached: true };
  }
  const inflight = fetchSessionFacts(uid);
  if (ttl > 0) {
    cache.set(uid, { expiresAt: now + ttl, inflight });
    // A failed lookup must not sit in the cache for the rest of the TTL: the
    // next caller would inherit the rejection instead of getting a fresh try.
    inflight.catch(() => {
      if (cache.get(uid)?.inflight === inflight) cache.delete(uid);
    });
  }
  return { facts: inflight, cached: false };
}

/**
 * Drops a uid's cached facts on this instance. Called by `signOutAllDevices`
 * right after it revokes, so the instance that just performed the revoke never
 * serves its own stale "still valid" answer. It cannot reach the other warm
 * instances — that is what the short TTL is for.
 */
export function forgetSession(uid: string): void {
  cache.delete(uid);
}

/** Test seam: forget everything this module has cached. */
export function resetSessionRevocationCacheForTest(): void {
  cache.clear();
}

export type AuthCheckOutcome = 'skipped' | 'hit' | 'miss' | 'error' | 'revoked';

export interface RevocationCheck {
  outcome: AuthCheckOutcome;
  durationMs: number;
}

/**
 * Throws `unauthenticated` when the caller's ID token belongs to a session that
 * has been revoked, or to a disabled account. Resolves otherwise.
 *
 * Returns telemetry rather than logging it, so the one log line `wrapCallable`
 * already writes per invocation carries the cost instead of doubling the log
 * volume of the whole fleet.
 */
export async function assertSessionNotRevoked(
  req: CallableRequest<unknown>,
  functionName: string,
): Promise<RevocationCheck> {
  const uid = req.auth?.uid;
  if (!uid) return { outcome: 'skipped', durationMs: 0 };

  const start = Date.now();
  const { facts, cached } = sessionFacts(uid, start);
  let resolved: SessionFacts;
  try {
    resolved = await facts;
  } catch (err) {
    // Policy note 2 above: a lookup that fails is not evidence of revocation.
    logEvent({
      severity: 'warn',
      function: functionName,
      event: 'auth.revocationCheck.unavailable',
      uid,
      errorMessage: (err as Error)?.message,
      extra: { note: 'Identity Toolkit lookup failed; call allowed through. Pre-#557 behavior for this request.' },
    });
    captureFunctionError(err, { function: functionName, uid, kind: 'revocationCheck' });
    return { outcome: 'error', durationMs: Date.now() - start };
  }

  const durationMs = Date.now() - start;

  if (resolved.disabled) {
    throw new HttpsError('unauthenticated', DISABLED_MESSAGE, { reason: DISABLED_REASON });
  }

  // `auth_time` is seconds since epoch and is present on every Firebase-issued
  // ID token (`DecodedIdToken` declares it required). Absent means the request
  // did not come from one, so it is treated as epoch 0 — fail-closed against
  // any account that has ever been revoked.
  const authTimeSec = req.auth?.token?.auth_time;
  const authTimeMs = typeof authTimeSec === 'number' ? authTimeSec * 1000 : 0;
  if (resolved.validSinceMs > 0 && authTimeMs < resolved.validSinceMs) {
    throw new HttpsError('unauthenticated', REVOKED_MESSAGE, { reason: REVOKED_REASON });
  }

  return { outcome: cached ? 'hit' : 'miss', durationMs };
}
