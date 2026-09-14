package com.tribetails.auntieos.data.repository

import com.google.firebase.auth.FirebaseAuthException

/**
 * #886: which sign-in failures count toward a lockout, and how the lockout
 * itself is recognised, for the AuntieOS Android admin.
 *
 * `recordFailedLogin` counts failures, warns at 5 and locks at 10, and
 * `beforeSignIn` refuses a locked account. Neither did anything while no client
 * reported a failure. Mirrors `auntieos-admin/src/lib/failedLogin.ts`.
 */

/** Names the control on the sign-in screen that clears a lock: a password reset. */
internal const val ACCOUNT_LOCKED_MSG =
    "This account is locked after too many sign-in attempts. Use \"Forgot password?\" below to reset the password, then sign in with the new one."

/**
 * Wrong password, no such user, and the enumeration-protected form that is
 * either. `ERROR_USER_DISABLED` and `ERROR_INVALID_EMAIL` are deliberately
 * absent, and a network or too-many-requests failure is not a
 * [FirebaseAuthException] at all.
 */
private val CREDENTIAL_ERROR_CODES = setOf(
    "ERROR_WRONG_PASSWORD",
    "ERROR_USER_NOT_FOUND",
    "ERROR_INVALID_CREDENTIAL",
    "ERROR_INVALID_LOGIN_CREDENTIALS",
)

/**
 * `beforeSignIn` refused a locked account. The refusal arrives wrapped in
 * Identity Toolkit's `BLOCKING_FUNCTION_ERROR_RESPONSE`, whose error code is a
 * generic internal one, so the server's own sentence ("This account is locked.
 * ...") is what identifies it. Checked down the cause chain.
 */
internal fun isAccountLockedFailure(t: Throwable): Boolean =
    generateSequence(t) { it.cause }
        .take(8)
        .any { it.message?.contains("account is locked", ignoreCase = true) == true }

/** True only for the failures a guessed password produces. */
internal fun isCredentialSignInFailure(t: Throwable): Boolean {
    if (isAccountLockedFailure(t)) return false
    val code = (t as? FirebaseAuthException)?.errorCode ?: return false
    return code in CREDENTIAL_ERROR_CODES
}
