import { FirebaseError } from 'firebase/app';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from './firebase';

/**
 * What the portal does when the backend says this session is over (#557).
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THAT ALL LOOK LIKE "unauthenticated", AND WHY THEY DIFFER
 * ---------------------------------------------------------------------------
 * 1. NOT SIGNED IN. The callable is refused with a bare `unauthenticated` and
 *    no reason. Nothing to tear down — the route guards already own this, and
 *    reacting here would fight them.
 *
 * 2. TOKEN EXPIRED / CANNOT BE REFRESHED. This one never reaches a callable as
 *    a tagged error: an expired token is rejected by the Functions runtime
 *    before our own wrapper sees it, and a refresh that keeps failing is
 *    already owned by `sessionHealth.ts`, which shows the session notice and
 *    retries on a backoff. Retrying is the right answer there, because bad wifi
 *    is the common cause and it clears itself.
 *
 * 3. SESSION REVOKED, OR ACCOUNT DISABLED. `wrapCallable` tags these with
 *    `details.reason`. Retrying can never fix them: the account has ended this
 *    session (sign-out on another device, a password change, an operator
 *    disabling the account). Anything short of signing out here leaves the
 *    portal looping on a call that will be refused until the token expires,
 *    which is the "the app just stopped working" shape from the kinfolk's side.
 *
 * Only case 3 tears the session down. That is the whole distinction.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEARDOWN HERE IS MINIMAL, AND NOT `auth.ts`'s `signOut()`
 * ---------------------------------------------------------------------------
 * The deliberate sign-out path does push-token cleanup and a server-side
 * `signOutAllDevices` first, both of which are AUTHENTICATED CALLABLES. With a
 * revoked token they are refused — and being refused is what got us here, so
 * calling them would re-enter this module. A revoked session also has nothing
 * left to revoke: the server already did it.
 *
 * So this does the three things that are still both possible and necessary:
 * end the local Firebase session, drop the cached tribe access, and land on
 * /signin. A full document navigation rather than an in-SPA hop, for the same
 * reason `auth.ts` reloads on sign-out: a page that may have activated App
 * Check needs a clean `grecaptcha` before the next sign-in.
 */

/** The `details.reason` values `functions/src/lib/sessionRevocation.ts` sends. */
export const REVOKED_REASON = 'session-revoked';
export const DISABLED_REASON = 'user-disabled';

export type SessionEndedReason = typeof REVOKED_REASON | typeof DISABLED_REASON;

/**
 * Reads the reason off a callable rejection, or null when the error is not one
 * of the two the server tags.
 *
 * Checks `details.reason` first (the clean signal) and falls back to the
 * message text, which carries the same token. The fallback is not paranoia: a
 * callable error crossing a proxy or an SDK version that drops `details` still
 * carries its message, and going deaf here means the kinfolk keeps tapping a
 * portal that refuses everything.
 */
export function sessionEndedReason(err: unknown): SessionEndedReason | null {
  if (typeof err !== 'object' || err === null) return null;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && !code.endsWith('unauthenticated')) return null;

  const details = (err as { details?: unknown }).details;
  const reason =
    typeof details === 'object' && details !== null
      ? (details as { reason?: unknown }).reason
      : undefined;
  if (reason === REVOKED_REASON || reason === DISABLED_REASON) return reason;

  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string') {
    if (message.includes(REVOKED_REASON)) return REVOKED_REASON;
    if (message.includes(DISABLED_REASON)) return DISABLED_REASON;
  }
  return null;
}

/** Copy the sign-in screen shows after an involuntary sign-out. */
export function sessionEndedMessage(reason: SessionEndedReason): string {
  return reason === DISABLED_REASON
    ? 'This account has been turned off. Please contact Auntie.'
    : 'Your session ended, so we signed you out. Please sign in again.';
}

/** Where the notice is left for the sign-in screen to pick up after the reload. */
export const SESSION_ENDED_STORAGE_KEY = 'mytribe.sessionEndedNotice';

/**
 * Reads the notice left by the teardown and clears it, so it shows once and
 * does not reappear on the next visit to /signin. Returns null when there is
 * nothing to say, which is the ordinary case.
 */
export function readAndClearSessionEndedNotice(): string | null {
  try {
    const notice = sessionStorage.getItem(SESSION_ENDED_STORAGE_KEY);
    if (notice) sessionStorage.removeItem(SESSION_ENDED_STORAGE_KEY);
    return notice;
  } catch {
    return null;
  }
}

let tearingDown = false;

/**
 * Re-arms the guard below. Called from `fns.ts` whenever a callable SUCCEEDS,
 * because a call that succeeded is proof the current session works.
 *
 * The guard is a burst collapser, not a once-per-page latch. It normally does
 * not matter here, because the teardown ends in a document navigation and this
 * module's state dies with the page. It matters when that navigation does not
 * happen: `window.location.assign` is wrapped in a try/catch (jsdom, and any
 * embedding that refuses it), and without this a page that survived one
 * teardown would sit there with the guard closed, deaf to the next revocation.
 * The Android client had the same shape and no reload to hide it, so both are
 * fixed the same way. It cannot re-open the burst it collapses: during a burst
 * of refusals there are no successes.
 */
export function noteSessionAlive(): void {
  tearingDown = false;
}

/** Test seam: forget that a teardown already ran. */
export function resetRevokedSessionForTest(): void {
  tearingDown = false;
}

/**
 * Ends the local session and sends the kinfolk to /signin with a reason.
 *
 * Reentrancy-guarded: a screen that fired six callables in parallel gets six
 * refusals, and six sign-outs racing six navigations is not a thing anyone
 * wants to debug. The first one wins; the rest return immediately.
 */
export async function endRevokedSession(reason: SessionEndedReason): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;

  try {
    sessionStorage.setItem(SESSION_ENDED_STORAGE_KEY, sessionEndedMessage(reason));
  } catch {
    // Private mode / storage disabled. The sign-out below still has to happen;
    // the kinfolk just lands on /signin without the explanation.
  }

  try {
    await firebaseSignOut(auth);
  } catch {
    // Nothing left to do about it locally, and the navigation below still gets
    // them off the authenticated surface.
  }

  // Deliberately a call-time import, not a top-level one. `lib/fns.ts` imports
  // this module, and `activeTribe.ts` reaches `lib/fns.ts` again through
  // `api/portal.ts` — a static edge here would close that loop at module
  // evaluation time, which is a bundler-ordering bug waiting to happen on a
  // path that only runs when something has already gone wrong. Deferring it to
  // the moment of teardown means the cycle never exists.
  try {
    const { clearAccess } = await import('./activeTribe');
    clearAccess();
  } catch {
    // A chunk that will not load cannot stop the sign-out below from landing.
  }

  try {
    window.location.assign('/signin');
  } catch {
    // jsdom throws "Not implemented: navigation". The auth store has already
    // flipped to signedOut, which is what the route guards read.
  }
}

/**
 * Wraps a callable rejection: tears the session down when the server says it is
 * over, then rethrows so the caller's own error handling still runs. Never
 * swallows — a screen that was going to show a banner should still show one.
 */
export async function reactToCallableError(err: unknown): Promise<void> {
  const reason = sessionEndedReason(err);
  if (reason) await endRevokedSession(reason);
}

/** Narrow helper for callers that only have a `FirebaseError` in hand. */
export function isSessionEndedError(err: unknown): err is FirebaseError {
  return sessionEndedReason(err) !== null;
}
