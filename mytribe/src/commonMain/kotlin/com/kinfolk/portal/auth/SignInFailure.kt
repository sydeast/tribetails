package com.kinfolk.portal.auth

/**
 * #886: what a failed email and password sign-in means for the lockout.
 *
 * `recordFailedLogin` counts credential failures, warns the household at 5 and
 * locks the account at 10; `beforeSignIn` then refuses the locked account. None
 * of it ran while no client reported a failure. Each [AuthBackend] knows how its
 * own SDK spells an error, and hands the code and text to [classifySignInFailure]
 * so the rule lives in one place for Android, web and desktop.
 */
enum class SignInFailureKind {
    /** A guessed password: wrong password, no such user, or the enumeration-protected form of either. Reported. */
    Credentials,

    /** `beforeSignIn` refused a locked account. Shown as [ACCOUNT_LOCKED_MESSAGE], never reported. */
    Locked,

    /** Everything else: network, too many requests, a disabled user, a malformed email. Never reported. */
    Other,
}

/**
 * What the kinfolk reads when the account is locked. It names the control that
 * clears it, which on this screen sits above the Jump back in! button.
 */
const val ACCOUNT_LOCKED_MESSAGE =
    "This account is locked after too many sign-in attempts. Tap \"Forgot password?\" above to reset your password, then sign in with the new one."

/** Thrown by [AuthRepository.signInWithEmailPassword] in place of `beforeSignIn`'s raw refusal. */
class AccountLockedException(cause: Throwable? = null) : IllegalStateException(ACCOUNT_LOCKED_MESSAGE, cause)

/**
 * The three spellings of a credential failure: the JS SDK's `auth/...`, the
 * Android SDK's `ERROR_...`, and Identity Toolkit REST's upper-case message.
 * `user-disabled`, `invalid-email` and `too-many-requests` in any spelling are
 * deliberately absent.
 */
private val CREDENTIAL_CODES = setOf(
    "auth/wrong-password",
    "auth/user-not-found",
    "auth/invalid-credential",
    "auth/invalid-login-credentials",
    "ERROR_WRONG_PASSWORD",
    "ERROR_USER_NOT_FOUND",
    "ERROR_INVALID_CREDENTIAL",
    "ERROR_INVALID_LOGIN_CREDENTIALS",
    "INVALID_PASSWORD",
    "EMAIL_NOT_FOUND",
    "INVALID_LOGIN_CREDENTIALS",
)

/**
 * `beforeSignIn`'s refusal travels inside Identity Toolkit's
 * `BLOCKING_FUNCTION_ERROR_RESPONSE`, whose code is a generic internal error on
 * every SDK, so the server's sentence ("This account is locked. ...") is what
 * identifies it.
 */
fun isAccountLockedText(text: String?): Boolean = text?.contains("account is locked", ignoreCase = true) == true

/** [code] is the SDK's error code when it has one; [text] is the error's message or body. */
fun classifySignInFailure(code: String?, text: String?): SignInFailureKind = when {
    isAccountLockedText(text) -> SignInFailureKind.Locked
    code != null && code in CREDENTIAL_CODES -> SignInFailureKind.Credentials
    else -> SignInFailureKind.Other
}
