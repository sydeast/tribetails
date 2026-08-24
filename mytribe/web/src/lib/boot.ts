import { ensureRecaptcha, waitForAuthReady } from './auth';

/**
 * Which reCAPTCHA Enterprise loader this page lifetime is allowed to have.
 *
 * There can only be one. Google's `enterprise.js` takes ownership of
 * `window.grecaptcha`, and whichever Firebase stream loads it second executes
 * its own site key against the first one's instance: Identity Platform dies
 * with "Invalid site key or not loaded in api.js" and the sign-in button spins
 * forever, or App Check's token promise pends silently and every callable
 * stalls before the network. Both directions were observed live and are
 * written up in `firebase.ts` (S7-BLOCKER-1) and
 * `docs/O3_APP_CHECK_RULING_2026-07-13.md`.
 *
 * So the choice is made once, at boot, from the only thing that predicts what
 * the page is going to need:
 *
 *   signed out -> the AUTH loader. Sign-in, claim and password reset are what
 *                 those surfaces do, and Identity Toolkit rejects a tokenless
 *                 sign-in with HTTP 503 "Error code: 47".
 *   signed in  -> the APP CHECK loader. That session makes callables, and
 *                 nothing on it signs in.
 *
 * A kinfolk who signs in through the form therefore finishes that session
 * without App Check and picks it up on their next page load. That is the
 * Phase 1 trade the O-3 ruling accepts, and it is why the backend cannot be
 * flipped to hard enforcement yet (see functions/src/lib/appCheckPolicy.ts).
 * Unifying the two streams onto one loader is Phase 2 and is not this.
 *
 * ISSUE #556 IS WHAT HAPPENS WITHOUT THE GATE. `main.tsx` used to call
 * `ensureRecaptcha()` unconditionally at module init, before the auth listener
 * could fire. That set auth.ts's `recaptchaReady` promise on every boot, which
 * made `authRecaptchaLoaded()` permanently true, which made the
 * `activateAppCheck()` call behind it unreachable. App Check never activated
 * in the portal at all, on any session, on any boot, while every comment in
 * the tree said it did.
 */
export function bootAttestation(): Promise<void> {
  return waitForAuthReady().then((state) => {
    // Signed in: auth.ts's listener has already called activateAppCheck() by
    // the time this resolves — it activates before it notifies subscribers,
    // and waitForAuthReady is a subscriber. Touching the auth loader now would
    // be the collision.
    if (state.status !== 'signedOut') return;
    // Signed out: install the interceptor now rather than at the first sign-in
    // attempt. Every auth call awaits `ensureRecaptcha()` anyway, so this is a
    // head start rather than a correctness requirement — but it is the head
    // start the Kotlin app's sign-in race needed.
    return ensureRecaptcha();
  });
}
