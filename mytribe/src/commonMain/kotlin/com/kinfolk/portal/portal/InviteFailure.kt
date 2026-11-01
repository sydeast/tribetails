package com.kinfolk.portal.portal
/**
 * #1277: what a household sees when an invite is refused because the backend
 * is missing a setting.
 *
 * `requireBaseUrl` (functions/src/lib/requireBaseUrl.ts) refuses with
 * `failed-precondition` "<ENV_VAR_NAME> is not configured". That text is for
 * the operator's logs; shown under Send Invite it read
 * "AUNTIE_OS_REVIEW_BASE_URL is not configured [400]".
 *
 * Matched on the message shape, not a code: no platform here surfaces the
 * callable code the same way, and `addSecondaryContact` also refuses with
 * `failed-precondition` for "You cannot invite yourself." and "This secondary
 * kinfolk already has portal access.", which the household must still see.
 *
 * "It's been reported to Auntie" is true: the server's `wrapCallable` writes
 * every refusal as a FAILURE `activity_log` row, which the daily error digest
 * emails to the business.
 *
 * Same text and rule as portal web's `INVITES_UNAVAILABLE_MESSAGE` /
 * `isConfigGapError` (web/src/lib/inviteFailure.ts).
 */
const val INVITES_UNAVAILABLE_MESSAGE = "Invites can't be sent right now. It's been reported to Auntie."
private val CONFIG_GAP = Regex("""\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+ is not configured\b""")
/** True when [t] is a backend "<ENV_VAR_NAME> is not configured" refusal. */
fun isConfigGapError(t: Throwable): Boolean = t.message?.let { CONFIG_GAP.containsMatchIn(it) } == true
/** The line under Send Invite for a failed invite: plain for a config gap, otherwise the server's own refusal. */
fun inviteFailureLine(t: Throwable): String =
    if (isConfigGapError(t)) INVITES_UNAVAILABLE_MESSAGE else "Invite failed: ${t.message ?: t}"
