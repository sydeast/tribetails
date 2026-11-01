/**
 * #1277: what a household sees when an invite is refused because the backend
 * is missing a setting.
 *
 * `requireBaseUrl` (functions/src/lib/requireBaseUrl.ts) refuses with
 * `failed-precondition` "<ENV_VAR_NAME> is not configured". That text is for
 * the operator's logs. Shown under Send Invite it read "AUNTIE_OS_REVIEW_BASE_URL
 * is not configured [400]", which tells a household nothing they can act on.
 *
 * Matched on the message shape, not the code alone: `addSecondaryContact` also
 * refuses with `failed-precondition` for "You cannot invite yourself." and
 * "This secondary kinfolk already has portal access.", and the household must
 * still see those. The code is not required either, so a refusal that reached
 * the client re-wrapped (a status suffix, a lost code) is still caught.
 *
 * "It's been reported to Auntie" is true: `wrapCallable` writes every refusal
 * as a FAILURE `activity_log` row, which the daily error digest emails to the
 * business. Same wording as the server's own opaque error.
 *
 * Same text and rule as portal Android's `INVITES_UNAVAILABLE_MESSAGE` /
 * `isConfigGapError` (src/commonMain/.../portal/InviteFailure.kt).
 */
export const INVITES_UNAVAILABLE_MESSAGE = "Invites can't be sent right now. It's been reported to Auntie.";
const CONFIG_GAP = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+ is not configured\b/;
/** True when [err] is a backend "<ENV_VAR_NAME> is not configured" refusal. */
export function isConfigGapError(err: unknown): boolean {
  return err instanceof Error && CONFIG_GAP.test(err.message);
}
