package com.tribetails.auntieos.ui.admin

// Plausibility check only - Firebase Auth enforces real RFC validation
// server-side. This gates the local "Send Reset Email" button from firing on
// obvious garbage. Pattern: <local>@<host>.<tld+>
private val EMAIL_REGEX = Regex("""^[^\s@]+@[^\s@]+\.[^\s@]+$""")

internal fun isPlausibleEmail(s: String): Boolean {
    val trimmed = s.trim()
    if (trimmed.isEmpty()) return false
    return EMAIL_REGEX.matches(trimmed)
}

/**
 * Maps a Firebase Auth failure to operator-facing copy for credential changes
 * (spec 29 item 15.4). Reads FirebaseAuthException.errorCode when present so the
 * message is specific; otherwise surfaces the raw message (never swallowed).
 * Pure; unit-tested via [friendlyAuthErrorForCode].
 */
internal fun friendlyAuthError(e: Throwable): String {
    val code = (e as? com.google.firebase.auth.FirebaseAuthException)?.errorCode
    return friendlyAuthErrorForCode(code, e.message)
}

internal fun friendlyAuthErrorForCode(code: String?, rawMessage: String?): String = when (code) {
    "ERROR_WRONG_PASSWORD", "ERROR_INVALID_CREDENTIAL" -> "Current password is incorrect."
    "ERROR_REQUIRES_RECENT_LOGIN" -> "Please sign in again, then retry this change."
    "ERROR_EMAIL_ALREADY_IN_USE" -> "That email is already in use."
    "ERROR_INVALID_EMAIL" -> "That email doesn't look right."
    "ERROR_WEAK_PASSWORD" -> "Choose a stronger password (at least 6 characters)."
    "ERROR_TOO_MANY_REQUESTS" -> "Too many attempts. Wait a minute and try again."
    "ERROR_NETWORK_REQUEST_FAILED" -> "Network hiccup. Try again."
    else -> rawMessage?.takeIf { it.isNotBlank() }?.let { "Couldn't complete that change: $it" }
        ?: "Couldn't complete that change."
}
