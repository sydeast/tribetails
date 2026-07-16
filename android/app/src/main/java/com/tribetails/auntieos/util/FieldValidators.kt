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

/** Optional field: blank is allowed, but a non-blank value must be a valid phone. */
fun phoneOkOrBlank(raw: String): Boolean = raw.isBlank() || isValidPhone(raw)

/** Optional field: blank is allowed, but a non-blank value must be a valid email. */
fun emailOkOrBlank(raw: String): Boolean = raw.isBlank() || isValidEmail(raw)
