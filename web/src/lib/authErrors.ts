/**
 * Maps Firebase Auth / callable failures to friendly inline copy.
 * Pure function so vitest can cover every branch.
 */

export interface FriendlyError {
  /** Short, grandma-friendly message for the inline error banner. */
  message: string;
  /** Coarse category, lets screens choose behavior (e.g. retry hint). */
  kind: 'credentials' | 'rateLimit' | 'network' | 'unknown';
}

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

export function mapAuthError(err: unknown): FriendlyError {
  const code = codeOf(err);
  const msg = messageOf(err);
  const all = `${code} ${msg}`;

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
