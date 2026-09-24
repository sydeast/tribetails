package com.kinfolk.portal.auth

/**
 * #905: what a failed password-reset send means for what the household reads.
 *
 * Every portal client (web, Android, desktop) sends resets through our own
 * `requestPasswordReset` callable, which emails the link from the operator's
 * `auth.password.reset` template. Firebase's native reset email is not used:
 * its console template cannot be edited on this project.
 *
 * The callable answers `{ ok: true }` for a known, unknown, locked or capped
 * address alike, so success says nothing about whether an address is an
 * account and needs no special handling. It refuses in only two ways a screen
 * should tell apart:
 *
 *   - `resource-exhausted`: the per-IP limit (30 requests per 5 minutes).
 *     Trying again at once is exactly what will not work, so the screen says
 *     to wait ([RESET_RATE_LIMITED_MESSAGE]) instead of "try again".
 *   - everything else (a malformed address, a network failure, a server
 *     error): the screen's own "Couldn't send reset email" wording.
 *
 * Neither says anything about the account.
 *
 * (#911 had moved Android and desktop onto Firebase's reset because the
 * callable's per-email cap could be spent by a stranger. #905's server change
 * keys that cap by email AND network, so a stranger spends only their own.)
 */

/** Same words as the claim card's and portal web's rate-limit copy. */
const val RESET_RATE_LIMITED_MESSAGE = "Too many tries for now. Wait a few minutes, then try again."

/**
 * Whether a reset send was refused by the callable's per-IP limit.
 *
 * Callable errors reach the Kotlin clients as text, not a shared code: the
 * native Android SDK and the JS SDK carry the server's message ("Too many
 * requests. Try again later.", `checkIpRateLimit` in loginSecurity.ts), and the
 * desktop REST client carries the response body, whose status is
 * `RESOURCE_EXHAUSTED`. So all of those spellings are checked, in the message
 * and in `toString()`, the same approach as `isRateLimited` in TribeScreen.kt.
 */
fun isResetRateLimited(text: String?): Boolean {
    val m = text?.lowercase() ?: return false
    return "resource-exhausted" in m ||
        "resource_exhausted" in m ||
        "too many requests" in m ||
        "too many attempts" in m
}

/** [isResetRateLimited] for a throwable, reading both its message and `toString()`. */
fun isResetRateLimited(t: Throwable): Boolean =
    isResetRateLimited(t.message) || isResetRateLimited(t.toString())
