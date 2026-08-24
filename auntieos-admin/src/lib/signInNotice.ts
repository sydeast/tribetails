/**
 * One sentence, left behind for the sign-in screen by whatever just put the
 * operator back in front of it.
 *
 * WHY A STORAGE HANDOFF AND NOT REACT STATE. Both writers end the page: a
 * revoked session navigates the document to /signin (`lib/revokedSession.ts`),
 * and a denied non-admin reloads it when App Check owns `grecaptcha`
 * (`screens/SignIn.tsx`). React state does not survive either, and an operator
 * who lands on a login form with no explanation reads it as the app having
 * broken — which is the complaint behind #573 in the first place.
 *
 * ONE CHANNEL FOR BOTH, not one per writer. The screen shows one banner, so a
 * second key would only create the case where two notices are pending and one
 * of them is silently dropped.
 *
 * Every access is wrapped: `sessionStorage` throws outright in some privacy
 * modes, and a notice is never worth failing a sign-out over.
 */
export const SIGN_IN_NOTICE_STORAGE_KEY = 'auntieos.signInNotice';

/** Leave [message] for the next render of the sign-in screen. */
export function recordSignInNotice(message: string): void {
  try {
    sessionStorage.setItem(SIGN_IN_NOTICE_STORAGE_KEY, message);
  } catch {
    // Private mode / storage disabled. The sign-out this accompanies still has
    // to happen; the operator just lands on /signin without the explanation.
  }
}

/**
 * Read the pending notice and clear it, so it shows once and does not reappear
 * on the next visit to /signin. Returns null when there is nothing to say,
 * which is the ordinary case.
 */
export function readAndClearSignInNotice(): string | null {
  try {
    const notice = sessionStorage.getItem(SIGN_IN_NOTICE_STORAGE_KEY);
    if (notice) sessionStorage.removeItem(SIGN_IN_NOTICE_STORAGE_KEY);
    return notice;
  } catch {
    return null;
  }
}
