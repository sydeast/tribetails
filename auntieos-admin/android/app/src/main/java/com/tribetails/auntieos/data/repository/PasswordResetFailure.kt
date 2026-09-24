package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctionsException

/**
 * How a refused `requestPasswordReset` call reads on screen.
 *
 * The callable answers `{ ok: true }` for every address, known or not, so a
 * refusal is never about the account. It is the per-IP limit
 * (`resource-exhausted`), a malformed address (`invalid-argument`) or the
 * network. Both callers show the exception's message (the sign-in screen as is,
 * Settings after "Failed to send reset email: "), so the message is the
 * operator-facing sentence, in the same words `friendlyAuthErrorForCode` uses for
 * the native equivalents.
 */
internal const val RESET_TOO_MANY_MSG = "Too many attempts. Wait a minute and try again."
internal const val RESET_INVALID_EMAIL_MSG = "That email doesn't look right."
internal const val RESET_NETWORK_MSG = "Network hiccup. Try again."

/** Pure: the sentence for a callable error [code], or null to keep the server's own message. */
internal fun passwordResetFailureMessage(code: FirebaseFunctionsException.Code?): String? = when (code) {
    FirebaseFunctionsException.Code.RESOURCE_EXHAUSTED -> RESET_TOO_MANY_MSG
    FirebaseFunctionsException.Code.INVALID_ARGUMENT -> RESET_INVALID_EMAIL_MSG
    FirebaseFunctionsException.Code.UNAVAILABLE,
    FirebaseFunctionsException.Code.DEADLINE_EXCEEDED -> RESET_NETWORK_MSG
    else -> null
}

/** The exception [AuntieRepository.sendPasswordReset] fails with, carrying [e] as its cause. */
internal fun passwordResetFailure(e: FirebaseFunctionsException): Throwable {
    val message = passwordResetFailureMessage(e.code) ?: return e
    return IllegalStateException(message, e)
}
