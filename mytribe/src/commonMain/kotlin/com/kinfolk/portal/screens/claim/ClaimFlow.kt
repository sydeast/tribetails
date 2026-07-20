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

/** Returns a user-facing problem, or null when the password is acceptable. */
fun validateNewPassword(password: String, confirm: String): String? = when {
    password.length < 8 -> "Password needs at least 8 characters."
    password != confirm -> "Passwords don't match."
    else -> null
}
