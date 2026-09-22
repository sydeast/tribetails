package com.kinfolk.portal.screens.claim

/**
 * Pure decision logic for the invite-claim funnel, kept out of the Composable
 * so commonTest can hit every branch (same pattern as LaunchRouter /
 * StartRoute resolvers).
 *
 * The funnel a brand-new kinfolk walks:
 *   email link → preview invite → create account (set password) → acceptInvite
 * Returning kinfolk (account exists) flip to sign-in mode with the same email.
 * An already-signed-in session auto-accepts only when its email matches the
 * invite; otherwise we tell them whose invite this is and offer sign-out.
 */

/** Parsed result of the public getInvitePreview callable. */
data class InvitePreview(
    val status: String,
    val invitedEmail: String = "",
    val tribeName: String = "",
)

sealed interface ClaimStep {
    /** Preview fetch or acceptInvite in flight. */
    data object Loading : ClaimStep

    /** Signed out + claimable invite: collect a password (or sign in). */
    data class CreateAccount(val invitedEmail: String, val tribeName: String) : ClaimStep

    /** Signed in with the right email: call acceptInvite now. */
    data class AutoAccept(val invitedEmail: String) : ClaimStep

    /** Signed in as someone else: must sign out first. */
    data class WrongAccount(val invitedEmail: String, val currentEmail: String) : ClaimStep

    /** Invite can never be claimed (terminal). */
    data class InviteInvalid(val message: String) : ClaimStep
}

fun stepForPreview(
    preview: InvitePreview,
    signedIn: Boolean,
    signedInEmail: String?,
): ClaimStep = when (preview.status) {
    "valid" -> when {
        !signedIn -> ClaimStep.CreateAccount(preview.invitedEmail, preview.tribeName)
        signedInEmail != null &&
            signedInEmail.lowercase() == preview.invitedEmail.lowercase() ->
            ClaimStep.AutoAccept(preview.invitedEmail)
        else -> ClaimStep.WrongAccount(preview.invitedEmail, signedInEmail ?: "")
    }
    "claimed" -> ClaimStep.InviteInvalid(
        "This invite was already used. Sign in with your email and password instead.",
    )
    "expired" -> ClaimStep.InviteInvalid(
        "This invite has expired. Ask Auntie to send a fresh one.",
    )
    "revoked" -> ClaimStep.InviteInvalid(
        "This invite is no longer active. Ask Auntie to send a fresh one.",
    )
    else -> ClaimStep.InviteInvalid(
        "We couldn't find this invite. Check the link or ask Auntie to resend it.",
    )
}

/**
 * Firebase signals an existing account as EMAIL_EXISTS (REST) or
 * auth/email-already-in-use (JS SDK). Either way: switch to sign-in mode.
 */
fun isEmailAlreadyInUse(message: String?): Boolean {
    val m = message?.lowercase() ?: return false
    return "email_exists" in m || "email-already-in-use" in m || "email already in use" in m
}

/**
 * RULING: "secondary needs email verification as well."
 *
 * `acceptInvite` refuses an invitee whose address is not verified, and mails them
 * a verification link on the way out. That refusal is a step to take, not a
 * failure to retry, so the claim screen has to tell it apart from the OTHER
 * failed-precondition that callable throws for a dead invite.
 *
 * Mirrors `isEmailUnverified` in mytribe/web/src/lib/authErrors.ts.
 */
fun isEmailUnverified(message: String?): Boolean {
    val m = message?.lowercase() ?: return false
    return "failed-precondition" in m && "verif" in m
}
/** Returns a user-facing problem, or null when the password is acceptable. */
fun validateNewPassword(password: String, confirm: String): String? = when {
    password.length < 8 -> "Password needs at least 8 characters."
    password != confirm -> "Passwords don't match."
    else -> null
}

/**
 * #931: what the claim card shows when `getInvitePreview` or `claimInviteSignup`
 * refuses for its rate limit. Same words as portal web's rate-limit copy
 * (`mapAuthError`'s `rateLimit` kind in `mytribe/web/src/lib/authErrors.ts`).
 */
const val CLAIM_RATE_LIMITED_MESSAGE = "Too many tries for now. Wait a few minutes, then try again."

/**
 * The claim card's text for a failed preview or signup call: the rate-limit copy
 * when the callable refused for its limit (the native Android SDK carries the
 * server's "Too many attempts. Try again later." message, the desktop REST
 * client the RESOURCE_EXHAUSTED response body), otherwise the error's own
 * message, otherwise [fallback].
 *
 * Neither refusal is a connection problem, so it must not be told as one:
 * trying again immediately is exactly what will not work.
 */
fun claimErrorMessage(message: String?, fallback: String): String =
    if (com.kinfolk.portal.screens.tribe.isRateLimited(message)) CLAIM_RATE_LIMITED_MESSAGE else message ?: fallback
