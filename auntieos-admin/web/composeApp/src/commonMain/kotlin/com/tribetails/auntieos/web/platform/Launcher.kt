package com.tribetails.auntieos.web.platform

/**
 * Cross-platform `tel:` / `sms:` launcher (Stage 1, item 1F). Makes the Kinfolk-profile
 * hero Call/Text actions real instead of silent no-ops, across web (Wasm) + desktop (JVM).
 *
 * [telUri] / [smsUri] are pure + testable: they sanitize a free-text phone string into a
 * dialable URI (keep a leading '+', strip spaces/dashes/parens/dots), returning null when
 * there are no digits, so a blank/garbage number never launches a dead handler.
 */
fun telUri(raw: String): String? = dialUri("tel:", raw)

fun smsUri(raw: String): String? = dialUri("sms:", raw)

private fun dialUri(scheme: String, raw: String): String? {
    val trimmed = raw.trim()
    val plus = if (trimmed.startsWith("+")) "+" else ""
    val digits = trimmed.filter { it.isDigit() }
    return if (digits.isEmpty()) null else "$scheme$plus$digits"
}

/** Open a URI with the platform handler. Best-effort + fail-loud on error; never throws. */
expect fun launchUri(uri: String)

/** Dial [rawNumber] (no-op when it has no digits). */
fun launchTel(rawNumber: String) {
    telUri(rawNumber)?.let { launchUri(it) }
}

/** Open a new SMS to [rawNumber] (no-op when it has no digits). */
fun launchSms(rawNumber: String) {
    smsUri(rawNumber)?.let { launchUri(it) }
}
