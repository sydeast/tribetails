package com.tribetails.auntieos.util

import com.google.firebase.functions.FirebaseFunctionsException

/**
 * #1592: the operator was shown "updateInvoice validation failed". Every admin
 * callable refuses a bad payload with
 * `HttpsError('invalid-argument', '<name> validation failed', { validationErrors })`,
 * and the Android SDK hands that text through as the exception's message.
 * (The web SDK also appends the HTTP status, "[400]"; the rule drops that too,
 * so the three clients share one rule: web `callableErrorText.ts`, desktop
 * `CallableErrorText.kt`.)
 *
 *  - "<name> validation failed", an empty message, or a code's bare name
 *    ("INTERNAL") becomes a plain sentence for the code;
 *  - any other server message is already written for the operator and is kept,
 *    as are the machine tokens screens match on (`no_recipients`).
 */
private val PLAIN_BY_CODE: Map<String, String> = mapOf(
    "INVALID_ARGUMENT" to "Something in this form was not accepted. Check what you entered and try again.",
    "OUT_OF_RANGE" to "Something in this form was not accepted. Check what you entered and try again.",
    "FAILED_PRECONDITION" to "This cannot be done right now. Reload the screen and try again.",
    "PERMISSION_DENIED" to "Your account is not allowed to do this.",
    "UNAUTHENTICATED" to "You are signed out. Sign in again, then try once more.",
    "NOT_FOUND" to "That record was not found. It may have been deleted.",
    "ALREADY_EXISTS" to "That already exists.",
    "ABORTED" to "This changed while you were working on it. Reload the screen and try again.",
    "RESOURCE_EXHAUSTED" to "Too many tries in a short time. Wait a minute and try again.",
    "UNAVAILABLE" to "The server could not be reached. Try again in a moment.",
    "CANCELLED" to "That was cancelled before it finished. Try again.",
)

/** For INTERNAL, UNKNOWN, UNIMPLEMENTED and anything unnamed. */
const val CALLABLE_FALLBACK_TEXT = "Something went wrong on our side. Try again in a moment."

private val CODE_NAMES: Set<String> =
    PLAIN_BY_CODE.keys + setOf("INTERNAL", "UNKNOWN", "UNIMPLEMENTED", "DEADLINE_EXCEEDED", "DATA_LOSS", "OK")

private val VALIDATION_FAILED = Regex("^[a-z][A-Za-z0-9]*( [a-z][A-Za-z0-9]*)? validation failed\\.?$")
private val STATUS_SUFFIX = Regex("\\s*\\[\\d{3}]\\s*$")
private val SDK_STATUS_TEXT = Regex("^(Unknown backend error status|Backend error status):")

/** The operator's sentence for a callable error. [code] is the code's name, e.g. `INVALID_ARGUMENT` or `invalid-argument`. */
fun plainCallableMessage(code: String, message: String?): String {
    val bare = code.removePrefix("functions/").uppercase().replace('-', '_')
    val text = message.orEmpty().replace(STATUS_SUFFIX, "").trim()
    val forDeveloper = text.isEmpty() ||
        VALIDATION_FAILED.matches(text) ||
        SDK_STATUS_TEXT.containsMatchIn(text) ||
        text.uppercase().replace('-', '_') in CODE_NAMES
    if (!forDeveloper) return text
    return PLAIN_BY_CODE[bare] ?: CALLABLE_FALLBACK_TEXT
}

/**
 * The same exception with the operator's copy of its message: same [code],
 * same [details], the original as its cause. Returns this one unchanged when
 * the message was already for the operator.
 */
fun FirebaseFunctionsException.forOperator(): FirebaseFunctionsException {
    val plain = plainCallableMessage(code.name, message)
    if (plain == message) return this
    // The SDK's constructors are Kotlin-internal; see CallableExceptionCopy.java.
    return CallableExceptionCopy.withMessage(this, plain)
}
