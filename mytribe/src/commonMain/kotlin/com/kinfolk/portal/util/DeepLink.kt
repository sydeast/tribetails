package com.kinfolk.portal.util

/** Returns the invite id parsed from the platform's launch URL, or null. */
expect fun readInitialClaimInviteId(): String?

/**
 * Returns the share token parsed from the platform's launch URL, or null.
 *
 * Web hash forms: `#/share/<token>` or path `/share/<token>`.
 * Android: set via deep-link intent (MainActivity wires).
 * Desktop: set via `--share=<token>` JVM arg.
 */
expect fun readInitialShareToken(): String?

/**
 * A Firebase email action link the app was opened with (#905).
 *
 * Parsed by [com.kinfolk.portal.auth.parseEmailActionUrl] from
 * `https://kinfolk.tribetails.com/account/secure-reset` or `/account/action`.
 *
 * There is no `email` here, and that is the point. The field this type used to
 * carry came from an `email` query param, and the screen showed it as the
 * account. No Firebase link sends one, and a link is not evidence of whose
 * account it is, so the address now comes from the verified code alone. Losing
 * the field makes that structural rather than a rule somebody has to remember.
 *
 * @property oobCode     The code from the link. Blank when the link had none,
 *                       which the screen reports as "This link is incomplete."
 * @property mode        The link's `mode`, `resetPassword` when absent.
 * @property continueUrl An allowlisted continue target, or null.
 */
data class SecureResetParams(
    val oobCode: String,
    val mode: String = "resetPassword",
    val continueUrl: String? = null,
)

/**
 * Returns the email action link the app was launched with, or null.
 *
 * Android: set by MainActivity from the App Link's `intent.data`.
 * Web (Kotlin/JS): parsed from `window.location.href`.
 * Desktop: set from `--email-link=<url>` or the older `--secure-reset-oob=`
 * JVM arg. Desktop's auth backend cannot check a code, so the screen tells the
 * reader to open the link in a browser and files nothing.
 */
expect fun readInitialSecureResetParams(): SecureResetParams?

/**
 * True when the app was opened by a link it claims (an App Link or `mytribe://`)
 * that none of the launch parsers could place (#1293): `/share/` with no token,
 * `/claim/` with no invite, any other path the manifest matched. Only Android
 * ever answers true; web has the React portal's own not-found page and desktop
 * has no links.
 */
expect fun readInitialUnknownLink(): Boolean
/**
 * Whether a launch link names something the app can open. Pure so it is tested
 * without an Activity: [pathSegments] are the URI's path parts, [inviteQuery] its
 * `invite` query value, [isEmailAction] whether [com.kinfolk.portal.auth.parseEmailActionUrl]
 * accepted it. Mirrors `captureDeepLink` in MainActivity.
 */
fun deepLinkIsRecognized(pathSegments: List<String>, inviteQuery: String?, isEmailAction: Boolean): Boolean {
    fun idAfter(prefix: String): Boolean {
        val i = pathSegments.indexOf(prefix)
        return i >= 0 && i + 1 < pathSegments.size && pathSegments[i + 1].isNotBlank()
    }
    if (idAfter("claim") || idAfter("share")) return true
    if (pathSegments.lastOrNull() == "claim" && !inviteQuery.isNullOrBlank()) return true
    return isEmailAction
}
