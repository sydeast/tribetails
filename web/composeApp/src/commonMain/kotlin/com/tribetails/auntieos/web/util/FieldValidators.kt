package com.tribetails.auntieos.web.util

/**
 * Cross-cutting field-validation helpers used by Create/Edit forms.
 *
 * Kept here (not inside any single screen) so logic is testable on the JVM
 * without Compose UI dependencies and so all forms agree on what "a valid
 * phone" / "a valid email" means.
 *
 * Design notes:
 *   - **Email**: deliberately permissive RFC-ish check (anything@anything.tld).
 *     The server-side reCAPTCHA / SendGrid bounce check is the authoritative
 *     verifier; client-side just stops obviously-malformed strings.
 *   - **Phone**: digits + common separators (`+`, `-`, ` `, `(`, `)`, `.`).
 *     US rule: exactly 10 digits, or 11 with a leading `1` (country code).
 *     REJECTS alphabetic characters and short/long numbers (a 9-digit number
 *     like 719390420 is rejected). TribeTails is a US-only business.
 */

private val EMAIL_REGEX = Regex(
    "^[A-Za-z0-9](?:[A-Za-z0-9._%+\\-]*[A-Za-z0-9])?@" +
        "[A-Za-z0-9](?:[A-Za-z0-9.\\-]*[A-Za-z0-9])?\\.[A-Za-z]{2,}\$",
)

private val PHONE_ALLOWED_CHARS = Regex("^[+0-9()\\-. ]+\$")

/** True when [raw] is a non-blank string that matches the project's email shape. */
fun isValidEmail(raw: String): Boolean {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return false
    if (trimmed.length > 254) return false
    return EMAIL_REGEX.matches(trimmed)
}

/**
 * True when [raw] is a valid US phone: exactly 10 digits, or 11 with a leading
 * `1` country code, plus only allowed separators (no letters). A 9-digit number
 * is rejected.
 */
fun isValidPhone(raw: String): Boolean {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return false
    if (!PHONE_ALLOWED_CHARS.matches(trimmed)) return false
    val digits = trimmed.filter { it.isDigit() }
    return digits.length == 10 || (digits.length == 11 && digits.startsWith("1"))
}
