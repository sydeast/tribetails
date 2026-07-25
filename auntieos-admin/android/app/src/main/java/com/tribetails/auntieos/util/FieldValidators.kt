package com.tribetails.auntieos.util

/**
 * Field-validation helpers for Create/Edit Kinfolk forms. Mirrors the AuntieOS
 * web `FieldValidators` so both surfaces agree on what a valid phone/email is.
 *
 * Phone: US rule. Exactly 10 digits, or 11 with a leading `1` country code,
 * plus only common separators (`+ - . ( )` and space). Rejects letters and
 * short/long numbers (a 9-digit number like 719390420 is rejected).
 * Email: permissive RFC-ish shape; server is the authoritative verifier.
 */

private val EMAIL_REGEX = Regex(
    "^[A-Za-z0-9](?:[A-Za-z0-9._%+\\-]*[A-Za-z0-9])?@" +
        "[A-Za-z0-9](?:[A-Za-z0-9.\\-]*[A-Za-z0-9])?\\.[A-Za-z]{2,}\$",
)

private val PHONE_ALLOWED_CHARS = Regex("^[+0-9()\\-. ]+\$")

fun isValidEmail(raw: String): Boolean {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return false
    if (trimmed.length > 254) return false
    return EMAIL_REGEX.matches(trimmed)
}

fun isValidPhone(raw: String): Boolean {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return false
    if (!PHONE_ALLOWED_CHARS.matches(trimmed)) return false
    val digits = trimmed.filter { it.isDigit() }
    return digits.length == 10 || (digits.length == 11 && digits.startsWith("1"))
}

/**
 * E.164 shape check, for recipients who are not on the Kinfolk roster.
 *
 * [isValidPhone] above is a US rule (10 digits, or 11 with a leading 1). That is
 * right for the Kinfolk forms, whose households are a single Austin-area
 * business's clients. It is WRONG for the Communicate external send, which is a
 * one-off message to anybody at all: it silently rejected every valid
 * international number before the server ever saw it, so a message to a
 * `+447700900123` could not be sent and no error explained why.
 *
 * The server (MyTribe `sendExternalMessage`) validates with libphonenumber-js,
 * which knows every country's real numbering plan. This is deliberately WIDER
 * than that: E.164 allows 8 to 15 digits, and we accept anything in that range
 * made of digits and the punctuation people type. Wider is the correct direction
 * for a client mirror to err. A number we accept and the server rejects produces
 * a named server error the operator can read; a number we reject and the server
 * would have accepted is a message that can never be sent.
 *
 * Matches `isValidExternalPhone` in `auntieos-admin/src/lib/externalSend.ts`.
 */
fun isValidE164Phone(raw: String): Boolean {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return false
    if (!PHONE_ALLOWED_CHARS.matches(trimmed)) return false
    val digits = trimmed.count { it.isDigit() }
    return digits in 8..15
}

/** Optional field: blank is allowed, but a non-blank value must be a valid phone. */
fun phoneOkOrBlank(raw: String): Boolean = raw.isBlank() || isValidPhone(raw)

/** Optional field: blank is allowed, but a non-blank value must be a valid email. */
fun emailOkOrBlank(raw: String): Boolean = raw.isBlank() || isValidEmail(raw)
