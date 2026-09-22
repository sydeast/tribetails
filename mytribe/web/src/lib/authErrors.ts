/**
 * Maps Firebase Auth / callable failures to friendly inline copy.
 * Pure function so vitest can cover every branch.
 */

export interface FriendlyError {
  /** Short, grandma-friendly message for the inline error banner. */
  message: string;
  /** Coarse category, lets screens choose behavior (e.g. retry hint). */
  kind: 'locked' | 'credentials' | 'rateLimit' | 'network' | 'unknown';
}

/**
 * #886: what a kinfolk reads when `beforeSignIn` refuses a locked account.
 *
 * It names the control that is actually on the screen, because the point of
 * the message is the way out: a password reset clears the lock, and "Forgot
 * password?" is always under the Sign In button.
 */
export const ACCOUNT_LOCKED_MESSAGE =
  'This account is locked after too many sign-in attempts. Tap "Forgot password?" below to reset your password, then sign in with the new one.';

/** Extracts a Firebase-style error code ("auth/wrong-password") if present. */
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
  if (typeof err === 'string') return err.toLowerCase();
  return '';
}

/**
 * #886: `beforeSignIn` refused the sign-in because the account is locked.
 *
 * The refusal is an HttpsError thrown from a blocking function. Identity
 * Toolkit wraps it as `BLOCKING_FUNCTION_ERROR_RESPONSE : ((HTTP request to
 * .../beforeSignIn returned HTTP error 403: {"error":{"message":"This account
 * is locked. ...","status":"PERMISSION_DENIED"}}))` (captured verbatim from the
 * Auth emulator), and the JS SDK turns that into `auth/internal-error` carrying
 * the text after " : ". The code alone is every internal error, so the server's
 * own sentence is what identifies it.
 */
export function isAccountLockedError(err: unknown): boolean {
  return messageOf(err).includes('account is locked');
}

/**
 * #886: the sign-in failures that count toward a lock.
 *
 * Wrong password and no such user only (`auth/invalid-credential` is both, under
 * email enumeration protection). NOT `auth/invalid-email`, which is a malformed
 * address that never reached an account, and never a network failure,
 * `auth/too-many-requests`, `auth/user-disabled` or a `beforeSignIn` refusal:
 * reporting those would lock people out for problems that are not a guessed
 * password.
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
  return (
    msg.includes('invalid_login_credentials') ||
    msg.includes('invalid_password') ||
    msg.includes('email_not_found')
  );
}

/**
 * #910: a callable refused for its rate limit. The Functions SDK gives
 * `functions/resource-exhausted` with the server's message ("Too many attempts.
 * Try again later." from lib/rateLimit.ts). Mirrors Kotlin's `isRateLimited`.
 */
export function isRateLimitedError(err: unknown): boolean {
  const all = `${codeOf(err)} ${messageOf(err)}`;
  return all.includes('resource-exhausted') || all.includes('too many attempts');
}

export function mapAuthError(err: unknown): FriendlyError {
  const code = codeOf(err);
  const msg = messageOf(err);
  const all = `${code} ${msg}`;

  // First: the refusal text mentions an HTTP request, which the network branch
  // below would otherwise claim.
  if (isAccountLockedError(err)) {
    return { kind: 'locked', message: ACCOUNT_LOCKED_MESSAGE };
  }

  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found' ||
    code === 'auth/invalid-email' ||
    all.includes('invalid_login_credentials')
  ) {
    return {
      kind: 'credentials',
      message: 'That email and password did not match. Check for typos and try again.',
    };
  }

  if (code === 'auth/too-many-requests' || all.includes('too many')) {
    return {
      kind: 'rateLimit',
      message: 'Too many tries for now. Wait a few minutes, then try again.',
    };
  }

  if (
    code === 'auth/network-request-failed' ||
    all.includes('network') ||
    all.includes('failed to fetch') ||
    all.includes('load failed') ||
    all.includes('internet')
  ) {
    return {
      kind: 'network',
      message: 'We could not reach the internet. Check your connection and try again.',
    };
  }

  return {
    kind: 'unknown',
    message: 'Something went wrong on our end. Try again in a moment.',
  };
}

/**
 * Claim flow: Firebase signals an existing account as EMAIL_EXISTS (REST),
 * auth/email-already-in-use (JS SDK), or the claimInviteSignup callable's
 * already-exists HttpsError. Either way: switch to sign-in mode.
 * (Port of ClaimFlow.kt isEmailAlreadyInUse.)
 */
export function isEmailAlreadyInUse(err: unknown): boolean {
  const all = `${codeOf(err)} ${messageOf(err)}`;
  return (
    all.includes('email_exists') ||
    all.includes('email-already-in-use') ||
    all.includes('email already in use') ||
    all.includes('already-exists') ||
    all.includes('already exists')
  );
}

/**
 * Claim flow: `acceptInvite` refuses an invitee whose email is not verified
 * ("secondary needs email verification as well") and mails them a verification
 * link on the way out. Only the already-had-an-account population reaches this:
 * `claimInviteSignup` mints new accounts already verified, so a first-time
 * invitee never sees it.
 *
 * Matched on the message and not the code alone, because `failed-precondition`
 * is also how that callable reports a dead invite, and the two want different
 * screens: "verify and come back" against "this link is finished".
 */
export function isEmailUnverified(err: unknown): boolean {
  const all = `${codeOf(err)} ${messageOf(err)}`;
  return all.includes('failed-precondition') && all.includes('verif');
}
