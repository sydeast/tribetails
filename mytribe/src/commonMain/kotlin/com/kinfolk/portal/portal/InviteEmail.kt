package com.kinfolk.portal.portal
/**
 * #1326: whether an invite address is worth sending, and what to say when it
 * is not.
 *
 * Send Invite used to be enabled on `contains("@")` and said nothing when it
 * was disabled, so "bad-email" left a dead button with no reason. It also let
 * "a@b" through to a server that refuses it (`z.string().email()` in
 * functions/src/portal/addSecondaryContact.ts).
 *
 * Same rule and text as portal web's `isInvitableEmail` /
 * `INVALID_INVITE_EMAIL_MESSAGE` (web/src/lib/inviteEmail.ts).
 */
const val INVALID_INVITE_EMAIL_MESSAGE = "Enter a valid email."
private val EMAIL_SHAPE = Regex("""^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$""")
fun isInvitableEmail(raw: String): Boolean = EMAIL_SHAPE.matches(raw.trim())
/** The inline line under the field: null while it is empty or valid, so an untouched field never nags. */
fun inviteEmailProblem(raw: String): String? =
    if (raw.isBlank() || isInvitableEmail(raw)) null else INVALID_INVITE_EMAIL_MESSAGE
