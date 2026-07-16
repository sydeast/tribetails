import type { InvitePreviewResult } from './types';

/**
 * Pure decision logic for the invite-claim funnel, ported from the Kotlin
 * client (src/commonMain/kotlin/com/kinfolk/portal/screens/claim/ClaimFlow.kt)
 * so vitest can hit every branch.
 *
 * The funnel a brand-new kinfolk walks:
 *   email link -> preview invite -> create account (set password) -> acceptInvite
 * Returning kinfolk (account exists) flip to sign-in mode with the same email.
 * An already-signed-in session auto-accepts only when its email matches the
 * invite; otherwise we say whose invite this is and offer sign-out.
 */

export type ClaimStep =
  | { kind: 'loading' }
  | { kind: 'createAccount'; invitedEmail: string; tribeName: string }
  | { kind: 'autoAccept'; invitedEmail: string }
  | { kind: 'wrongAccount'; invitedEmail: string; currentEmail: string }
  | { kind: 'inviteInvalid'; message: string };

export function stepForPreview(
  preview: InvitePreviewResult,
  signedIn: boolean,
  signedInEmail: string | null,
): ClaimStep {
  switch (preview.status) {
    case 'valid':
      if (!signedIn) {
        return { kind: 'createAccount', invitedEmail: preview.invitedEmail, tribeName: preview.tribeName };
      }
      if (signedInEmail !== null && signedInEmail.toLowerCase() === preview.invitedEmail.toLowerCase()) {
        return { kind: 'autoAccept', invitedEmail: preview.invitedEmail };
      }
      return { kind: 'wrongAccount', invitedEmail: preview.invitedEmail, currentEmail: signedInEmail ?? '' };
    case 'claimed':
      return { kind: 'inviteInvalid', message: 'This invite was already used. Sign in with your email and password instead.' };
    case 'expired':
      return { kind: 'inviteInvalid', message: 'This invite has expired. Ask Auntie to send a fresh one.' };
    case 'revoked':
      return { kind: 'inviteInvalid', message: 'This invite is no longer active. Ask Auntie to send a fresh one.' };
    default:
      return { kind: 'inviteInvalid', message: "We couldn't find this invite. Check the link or ask Auntie to resend it." };
  }
}

/** Returns a user-facing problem, or null when the password is acceptable. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < 8) return 'Password needs at least 8 characters.';
  if (password !== confirm) return "Passwords don't match.";
  return null;
}

/**
 * Parses the invite id from a launch URL, matching the Kotlin deep-link
 * parser (src/jsMain DeepLink.js.kt): URL fragment `#/claim/<id>`, pathname
 * `/claim/<id>`, or the `?invite=<id>` query param. The query form is what
 * every invite email sends (`${CLAIM_LINK_BASE_URL}?invite=${id}`), so it
 * must parse here or the claim screen never mounts for invited kinfolk.
 */
export function parseInviteId(url: {
  hash: string;
  pathname: string;
  search: string;
}): string | null {
  const fromHash = parseSegment(url.hash.replace(/^#/, ''), 'claim');
  if (fromHash) return fromHash;
  const fromPath = parseSegment(url.pathname, 'claim');
  if (fromPath) return fromPath;
  const invite = new URLSearchParams(url.search).get('invite');
  return invite && invite.trim().length > 0 ? invite : null;
}

function parseSegment(s: string, prefix: string): string | null {
  const parts = s.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length >= 2 && parts[0] === prefix && parts[1] && parts[1].length > 0) {
    return parts[1];
  }
  return null;
}
/**
 * O-35: hard client-side bound for the auto-accept call. The callable SDK
 * acquires its context (auth/App Check/messaging tokens) BEFORE its own
 * timeout starts, so a stall there hangs past the 20s CallableTimeoutError
 * and the retry card never shows. Racing the whole call keeps the claim
 * screen honest no matter where the stall lives.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out. Please try again.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
