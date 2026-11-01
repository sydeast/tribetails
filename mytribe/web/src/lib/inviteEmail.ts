/**
 * #1326: whether an invite address is worth sending, and what to say when it
 * is not.
 *
 * Send Invite used to be enabled on `includes('@')` and said nothing when it
 * was disabled, so "bad-email" left a dead button with no reason. It also let
 * "a@b" through to a server that refuses it (`z.string().email()` in
 * functions/src/portal/addSecondaryContact.ts). This is the same shape check
 * the field needs before a send: something@something.something, no spaces.
 *
 * Same rule and text as portal Android's `isInvitableEmail` /
 * `INVALID_INVITE_EMAIL_MESSAGE` (src/commonMain/.../portal/InviteEmail.kt).
 */
export const INVALID_INVITE_EMAIL_MESSAGE = 'Enter a valid email.';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
export function isInvitableEmail(raw: string): boolean {
  return EMAIL_SHAPE.test(raw.trim());
}
/** The inline line under the field: null while it is empty or valid, so an untouched field never nags. */
export function inviteEmailProblem(raw: string): string | null {
  return raw.trim() === '' || isInvitableEmail(raw) ? null : INVALID_INVITE_EMAIL_MESSAGE;
}
