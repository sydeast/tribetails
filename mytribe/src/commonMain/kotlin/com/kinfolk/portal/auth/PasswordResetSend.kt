package com.kinfolk.portal.auth

/**
 * #911: what a failed password-reset send means for what the household reads.
 *
 * Portal Android and portal desktop used to send resets through the
 * `requestPasswordReset` callable, which answers `{ ok: true }` for a known,
 * unknown, locked or capped address alike. That constant answer is what kept
 * the screen from telling an unauthenticated caller whether an address is an
 * account, and it is also what let somebody spend an address's 3-a-day budget
 * and leave the household with a screen that says "Reset link sent" and no
 * email.
 *
 * Both clients now send through Firebase's own reset, which has no per-email
 * budget to drain but does refuse an address it has never seen. With email
 * enumeration protection OFF, an unknown address comes back
 * `EMAIL_NOT_FOUND` / `auth/user-not-found`; with it ON, the same address comes
 * back success. [isUnknownAccountOnReset] closes that difference at the client,
 * so the screen shows one sentence either way and the project setting is not
 * observable through the portal apps. (Turning the setting on is still worth
 * doing; it closes the same oracle for callers that skip our clients.)
 *
 * Nothing else is swallowed. A malformed address, an abuse refusal and a
 * network failure all keep today's "Couldn't send reset email.". None of them
 * says anything about whether the address is an account, and a household whose
 * link genuinely did not go out is owed the truth.
 */

/**
 * The three spellings of "no such account": the web SDK's `auth/...`, the
 * Android SDK's `ERROR_...`, and Identity Toolkit REST's upper-case message.
 * Same shape as [CREDENTIAL_CODES] in `SignInFailure.kt`.
 */
private val UNKNOWN_ACCOUNT_CODES = setOf(
    "auth/user-not-found",
    "ERROR_USER_NOT_FOUND",
    "EMAIL_NOT_FOUND",
)

/**
 * Whether a reset send failed only because the address is not an account.
 *
 * [code] is the SDK's error code when it has one ([platformAuthErrorCode]);
 * [text] is the error's message or response body. The text is checked as well
 * as the code because not every platform surfaces a code: the JVM actual reads
 * one only off a [com.kinfolk.portal.firebase.FirebaseRestException], so a
 * wrapped or re-thrown failure would otherwise arrive codeless. Same reasoning
 * as [isAccountLockedText], which identifies a locked account by the server's
 * sentence for the same reason.
 */
fun isUnknownAccountOnReset(code: String?, text: String?): Boolean {
    if (code != null && code in UNKNOWN_ACCOUNT_CODES) return true
    if (text == null) return false
    return UNKNOWN_ACCOUNT_CODES.any { text.contains(it) }
}

/** [isUnknownAccountOnReset] for a throwable, reading this platform's code off it. */
fun isUnknownAccountOnReset(t: Throwable): Boolean =
    isUnknownAccountOnReset(platformAuthErrorCode(t), t.message ?: t.toString())
