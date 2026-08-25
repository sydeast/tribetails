import { activateAppCheck, getAppCheckStatus } from './firebase';

/**
 * Which reCAPTCHA Enterprise loader this page lifetime is allowed to have
 * (#576).
 *
 * ---------------------------------------------------------------------------
 * THERE CAN ONLY BE ONE
 * ---------------------------------------------------------------------------
 * Google's `enterprise.js` takes ownership of `window.grecaptcha`, and whichever
 * Firebase stream loads it second executes its own site key against the first
 * one's instance. Both directions were observed live in the kinfolk portal and
 * are written up there (`MyTribe/web/src/lib/firebase.ts` S7-BLOCKER-1 and
 * `MyTribe/docs/O3_APP_CHECK_RULING_2026-07-13.md`): Identity Platform dies with
 * "Invalid site key or not loaded in api.js" and the sign-in button spins
 * forever, or App Check's token promise pends silently and every callable
 * stalls before the network.
 *
 * This app never calls `initializeRecaptchaConfig` the way the portal's
 * `ensureRecaptcha` does — but that does NOT mean it has no auth loader. The
 * Identity Platform reCAPTCHA keys on this project cover
 * `auntie.tribetails.com`, and the Auth SDK fetches its reCAPTCHA config on
 * demand during password sign-in when the project enforces it. So the collision
 * is available here too; it has simply never had a second stream to collide
 * with. Adding App Check is what supplies one, which is why this decision
 * exists rather than a bare `activateAppCheck()` at module init.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION, MADE ONCE, FROM THE FIRST RESOLVED AUTH STATE
 * ---------------------------------------------------------------------------
 *   signed out -> the AUTH loader. Sign-in is the only thing a signed-out admin
 *                 surface does, and a sign-in that hangs is worse than a
 *                 session that goes unattested for one page lifetime.
 *   signed in  -> the APP CHECK loader. That session makes callables, and
 *                 nothing on it signs in.
 *
 * An operator who signs in through the form therefore finishes that page
 * lifetime unattested and picks attestation up on their next full page load.
 * That is the same Phase 1 trade the O-3 ruling accepts for the portal, and it
 * is bounded: `lib/auth.ts`'s `signOut()` already reloads the document, and
 * `SignIn.tsx` navigates to /home, both of which start a fresh lifetime.
 *
 * ---------------------------------------------------------------------------
 * WHY "ONCE, FROM THE FIRST RESOLVED STATE" IS THE LOAD-BEARING PART
 * ---------------------------------------------------------------------------
 * Issue #556 is what happens when the gate is shaped even slightly differently.
 * The portal's `main.tsx` warmed the auth loader up at module init, before the
 * auth listener could fire; that set the readiness promise on every boot, which
 * made the "has the auth loader run?" guard PERMANENTLY TRUE, which made the
 * `activateAppCheck()` behind it unreachable. App Check never activated in the
 * portal at all, on any session, on any boot, while every comment in the tree
 * said it did.
 *
 * The guard here cannot take that shape, because it does not ask a question
 * that a module-level side effect can pre-answer. It reads the auth state the
 * Firebase listener resolved, and it latches on its own first call so a later
 * sign-in inside the same lifetime cannot re-open it. And whichever way it
 * goes, [getAppCheckStatus] afterwards is a value the tests and the console can
 * read: `active` and `failed` and `unconfigured` are all distinguishable from
 * the `inactive` this leaves behind when it deliberately does nothing.
 */

let decided = false;

/**
 * Called from `lib/auth.ts`'s `onAuthStateChanged` handler on the FIRST state
 * it resolves, before subscribers are notified — so any callable a subscriber
 * fires already carries a token, or already knows it will not have one.
 *
 * Idempotent: every call after the first is a no-op, which is what makes a
 * mid-lifetime sign-in unable to start the second reCAPTCHA stream.
 */
export function decideAttestation(signedIn: boolean): void {
  if (decided) return;
  decided = true;
  if (signedIn) activateAppCheck();
}

/** Whether the decision has been taken yet in this page lifetime. */
export function attestationDecided(): boolean {
  return decided;
}

/** Test seam: forget that the decision was taken. */
export function resetAttestationDecisionForTest(): void {
  decided = false;
}

/**
 * Whether this page lifetime has (or is getting) an App Check reCAPTCHA
 * instance, and therefore must not hand the page back to a sign-in form
 * without a full document reload first.
 *
 * `SignIn.tsx` uses this for the one path that would otherwise re-enter the
 * collision: a lifetime that booted signed-in-as-a-non-admin activates App
 * Check, is refused by the access gate, and then puts the sign-in form back on
 * the same document. `lib/revokedSession.ts` has the same problem and solves it
 * the same way, by navigating rather than swapping components.
 */
export function attestationOwnsRecaptcha(): boolean {
  const status = getAppCheckStatus();
  return status === 'pending' || status === 'active';
}
