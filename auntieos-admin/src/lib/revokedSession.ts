import { FirebaseError } from 'firebase/app';
import { signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from './firebase';
import { recordSignInNotice } from './signInNotice';

/**
 * What the AuntieOS admin does when the backend says this session is over
 * (#573, the admin half of #557).
 *
 * ---------------------------------------------------------------------------
 * FOUR THINGS THAT ALL LOOK LIKE A REFUSED CALL, AND WHY ONLY ONE ENDS THE
 * SESSION
 * ---------------------------------------------------------------------------
 * 1. NOT SIGNED IN. A bare `unauthenticated` with no reason attached. The
 *    router's `beforeLoad` guard already owns this; reacting here would fight
 *    it, and there is nothing left to tear down anyway.
 * 2. NOT AUTHORIZED. `permission-denied` — a signed-in operator whose `admin`
 *    claim does not cover this callable. Their session is fine; the screen
 *    shows the refusal and they carry on elsewhere. Signing them out would be
 *    a lie about what happened.
 * 3. THE NETWORK, OR A CANCELLATION. `functions/internal` (the SDK's label for
 *    any transport failure), `deadline-exceeded`, an aborted request. Retrying
 *    is the right answer to all of them, and it is usually the answer that
 *    works.
 * 4. SESSION REVOKED, OR ACCOUNT DISABLED. `functions/src/lib/
 *    sessionRevocation.ts` tags these with `details.reason`. Retrying can never
 *    clear them: the account has ended this session (a sign-out elsewhere, a
 *    password change, an operator disabling the account). Until this module
 *    existed the admin simply kept calling into a refusal it could not satisfy,
 *    which reads from the operator's side as the app having stopped working.
 *
 * Only case 4 tears the session down. That is the whole distinction.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TEARDOWN HERE IS MINIMAL, AND NOT `auth.ts`'s `signOut()`
 * ---------------------------------------------------------------------------
 * Two reasons, and only the second one is about this app specifically.
 *
 * The general one, inherited from the portal (`MyTribe/web/src/lib/
 * revokedSession.ts`): a revoked-session teardown must never call an
 * AUTHENTICATED callable, because being refused is what got us here and the
 * call would come straight back through this module. The admin's `signOut()`
 * happens not to call any today — but the portal's did not either until #539
 * added `signOutAllDevices` to it, so writing the teardown as its own path is
 * what keeps a future addition to `signOut()` from silently re-entering here.
 *
 * The specific one: `signOut()` ends with `window.location.reload()`, which
 * lands the operator back on whatever admin screen they were on. That screen
 * is guarded, so it bounces to /signin — but by way of a route redirect that
 * has no idea why, and the reason would be lost. Navigating to /signin
 * directly, with the reason left in `sessionStorage`, is what makes an
 * involuntary sign-out something the operator is told about rather than
 * something that just happens to them.
 *
 * A full document navigation rather than an in-SPA hop, for the same reason
 * `auth.ts`'s `signOut()` reloads: a page that activated App Check (#576) owns
 * `window.grecaptcha` through the Enterprise loader, and the next sign-in needs
 * a clean one. See `firebase.ts`'s `activateAppCheck` for that collision.
 */

/** The `details.reason` values `functions/src/lib/sessionRevocation.ts` sends. */
export const REVOKED_REASON = 'session-revoked';
export const DISABLED_REASON = 'user-disabled';

export type SessionEndedReason = typeof REVOKED_REASON | typeof DISABLED_REASON;

/**
 * Reads the reason off a callable rejection, or null when the error is not one
 * of the two the server tags.
 *
 * CLASSIFIES ON THE MACHINE SIGNAL, NEVER ON PROSE. `details.reason` is the
 * clean channel and is checked first. The message fallback is not prose
 * matching: `sessionRevocation.ts` deliberately embeds the SAME namespaced
 * tokens (`session-revoked`, `user-disabled`) in the message text, and its
 * header says in as many words to keep both matches or the clients go deaf —
 * an error crossing a proxy, or an SDK version that drops `details`, still
 * carries its message. Neither token appears in any Firebase message we do not
 * author, so the match stays specific. What is NOT matched, at all, is wording
 * like "session" or "revoked" on its own.
 *
 * The `code` guard keeps `permission-denied` out even in the impossible case
 * where a reason rode along with one.
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
    ? 'This account has been turned off. Ask another operator to turn it back on.'
    : 'Your session ended, so we signed you out. Please sign in again.';
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
 * The portal and the Kotlin clients had the same shape and are fixed the same
 * way. It cannot re-open the burst it collapses: during a burst of refusals
 * there are no successes.
 */
export function noteSessionAlive(): void {
  tearingDown = false;
}

/** Test seam: forget that a teardown already ran. */
export function resetRevokedSessionForTest(): void {
  tearingDown = false;
}

/**
 * Ends the local session and sends the operator to /signin with a reason.
 *
 * Reentrancy-guarded: an admin screen that fired six callables in parallel gets
 * six refusals, and six sign-outs racing six navigations is not a thing anyone
 * wants to debug. The first one wins; the rest return immediately.
 */
export async function endRevokedSession(reason: SessionEndedReason): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;

  recordSignInNotice(sessionEndedMessage(reason));

  try {
    await firebaseSignOut(auth);
  } catch {
    // Nothing left to do about it locally, and the navigation below still gets
    // them off the authenticated surface. The auth store has already been told
    // by the listener either way.
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
 * over, then the caller rethrows so its own error handling still runs. Never
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
