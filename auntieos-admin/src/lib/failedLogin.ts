import { call } from './fns';

/**
 * #886: failed sign-in reporting and the locked state, for the AuntieOS admin.
 *
 * `recordFailedLogin` counts failures, warns at 5 and locks at 10, and
 * `beforeSignIn` refuses a locked account. Neither did anything while no client
 * reported a failure. Mirrors `mytribe/web/src/lib/authErrors.ts`.
 */

/** Names the control on this screen that clears a lock: a password reset. */
export const ACCOUNT_LOCKED_MSG =
  'This account is locked after too many sign-in attempts. Use "Forgot password?" below to reset the password, then sign in with the new one.';

function codeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c.toLowerCase();
  }
  return '';
}

function messageOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m.toLowerCase();
  }
  return typeof err === 'string' ? err.toLowerCase() : '';
}

/**
 * `beforeSignIn` refused a locked account. The JS SDK reports the blocking
 * function's refusal as `auth/internal-error` carrying the server's sentence
 * ("This account is locked. ..."), so the sentence is what identifies it.
 */
export function isAccountLockedError(err: unknown): boolean {
  return messageOf(err).includes('account is locked');
}

/**
 * The failures that count toward a lock: wrong password, no such user, and
 * `auth/invalid-credential` (both, under enumeration protection). Never a
 * network failure, too-many-requests, a disabled user, a malformed email or
 * the locked refusal.
 */
export function isCredentialSignInError(err: unknown): boolean {
  if (isAccountLockedError(err)) return false;
  const code = codeOf(err);
  if (
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-login-credentials'
  ) {
    return true;
  }
  const msg = messageOf(err);
  return msg.includes('invalid_login_credentials') || msg.includes('invalid_password') || msg.includes('email_not_found');
}

/** Unauthenticated; the server answers `{ ok: true }` for every email, so nothing reads the result. */
export function reportFailedLogin(email: string): Promise<{ ok: true }> {
  return call<{ email: string }, { ok: true }>('recordFailedLogin', { email });
}

/**
 * Fire and forget: reports a credential failure and returns at once. Swallows
 * and logs its own failures (including the e2e harness's unstubbed-callable
 * refusal and an offline preflight), so a caller can rethrow its sign-in error
 * on the same tick.
 */
export function reportCredentialFailure(email: string, err: unknown): void {
  if (!isCredentialSignInError(err)) return;
  try {
    reportFailedLogin(email).catch((reportErr: unknown) => {
      console.warn('[Auth] recordFailedLogin report failed:', reportErr);
    });
  } catch (reportErr) {
    console.warn('[Auth] recordFailedLogin report failed:', reportErr);
  }
}
