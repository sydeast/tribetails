package com.kinfolk.portal.auth

import com.kinfolk.portal.util.SecureResetParams

/**
 * Firebase email action links, parsed the way the portal web page parses them
 * (`mytribe/web/src/lib/emailAction.ts`, #892 / PR #903). #905 brings the portal
 * Android app to the same contract.
 *
 * The project has ONE email action URL, `https://kinfolk.tribetails.com/account/secure-reset`,
 * and the web page also answers at `/account/action`. Every Firebase auth email
 * opens it: password resets, email verification and email-change links. The
 * Android manifest claims both paths, so the app receives every mode and has to
 * handle every mode (sending one back to the browser would bounce straight
 * back into the app, because the app owns the URL).
 *
 * No Firebase link carries an `email` param. The account always comes from the
 * verified code, never from the URL.
 */
object EmailAction {
    const val PORTAL_HOST = "kinfolk.tribetails.com"
    const val STAFF_HOST = "auntie.tribetails.com"
    const val STAFF_SIGN_IN_URL = "https://auntie.tribetails.com/signin"

    /** The paths the web page is routed at, and the paths the manifest claims. */
    val ACTION_PATHS = listOf("/account/secure-reset", "/account/action")

    const val MODE_RESET = "resetPassword"
    const val MODE_VERIFY = "verifyEmail"
    const val MODE_VERIFY_AND_CHANGE = "verifyAndChangeEmail"
    const val MODE_RECOVER = "recoverEmail"
    val HANDLED_MODES = setOf(MODE_RESET, MODE_VERIFY, MODE_VERIFY_AND_CHANGE, MODE_RECOVER)

    /** `checkActionCode` operations, spelled the way the web SDK spells them. */
    const val OP_PASSWORD_RESET = "PASSWORD_RESET"
    const val OP_VERIFY_EMAIL = "VERIFY_EMAIL"
    const val OP_VERIFY_AND_CHANGE_EMAIL = "VERIFY_AND_CHANGE_EMAIL"
    const val OP_RECOVER_EMAIL = "RECOVER_EMAIL"
    const val OP_OTHER = "OTHER"

    /**
     * What the code must really be for each link mode. The mode is a URL param
     * anyone can edit; the operation is what the code does. A mismatch is
     * refused with "This link can't be completed here."
     */
    val OPERATION_FOR_MODE = mapOf(
        MODE_RESET to OP_PASSWORD_RESET,
        MODE_VERIFY to OP_VERIFY_EMAIL,
        MODE_VERIFY_AND_CHANGE to OP_VERIFY_AND_CHANGE_EMAIL,
        MODE_RECOVER to OP_RECOVER_EMAIL,
    )
}

/**
 * Parses a full link, `https://kinfolk.tribetails.com/account/action?mode=..&oobCode=..`.
 *
 * Returns null when the link is not an action link at all (another host or
 * path). Returns params with a blank [SecureResetParams.oobCode] when it is an
 * action link with no code, so the screen can say "This link is incomplete."
 * rather than dropping the reader on the sign-in screen with no explanation.
 */
fun parseEmailActionUrl(url: String): SecureResetParams? {
    val withoutFragment = url.substringBefore('#')
    val schemeSplit = withoutFragment.indexOf("://")
    if (schemeSplit < 0) return null
    val scheme = withoutFragment.substring(0, schemeSplit).lowercase()
    if (scheme != "https") return null
    val rest = withoutFragment.substring(schemeSplit + 3)
    val hostEnd = rest.indexOfAny(charArrayOf('/', '?')).let { if (it < 0) rest.length else it }
    val host = rest.substring(0, hostEnd).lowercase()
    if (host != EmailAction.PORTAL_HOST) return null
    val pathAndQuery = rest.substring(hostEnd)
    val path = pathAndQuery.substringBefore('?').ifEmpty { "/" }
    val query = if ('?' in pathAndQuery) pathAndQuery.substringAfter('?') else ""
    return parseEmailActionLink(path, parseQuery(query))
}

/**
 * Parses an action link from its already-split path and decoded query.
 *
 * - Path must be one of [EmailAction.ACTION_PATHS] (a trailing slash is fine).
 * - `mode` defaults to `resetPassword` (the legacy `?oobCode=..` form).
 * - `continueUrl` survives only when [safeContinueUrl] allows it.
 * - Any `email` param is ignored.
 */
fun parseEmailActionLink(path: String, query: Map<String, String>): SecureResetParams? {
    val normalized = path.trimEnd('/').ifEmpty { "/" }
    if (normalized !in EmailAction.ACTION_PATHS) return null
    val oobCode = query["oobCode"]?.trim().orEmpty()
    val mode = query["mode"]?.takeIf { it.isNotBlank() } ?: EmailAction.MODE_RESET
    return SecureResetParams(
        oobCode = oobCode,
        mode = mode,
        continueUrl = safeContinueUrl(query["continueUrl"]),
    )
}

/**
 * The continue target, if the app may send people there.
 *
 * Allowed: https on the admin site or the portal. Anything else is dropped, so
 * a link can never turn the app into an open redirect. A target that is the
 * action page itself (the `requestPasswordReset` shape) becomes that host's
 * `/signin`, since sending someone back to this screen would be a loop. Mirrors
 * `safeContinueUrl` in `mytribe/web/src/lib/emailAction.ts`, minus the
 * same-origin case, which an app does not have.
 */
fun safeContinueUrl(raw: String?): String? {
    val host = httpsHostOf(raw) ?: return null
    if (host != EmailAction.PORTAL_HOST && host != EmailAction.STAFF_HOST) return null
    val trimmed = raw!!.trim()
    val rest = trimmed.removePrefix("https://")
    val hostEnd = rest.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) rest.length else it }
    val path = rest.substring(hostEnd).substringBefore('?').substringBefore('#')
    val origin = "https://$host"
    if (EmailAction.ACTION_PATHS.any { path == it || path.startsWith("$it/") }) return "$origin/signin"
    return trimmed
}

/**
 * The host of an `https://` URL, lowercased, or null when it is not one.
 *
 * Whole-host comparison is the only safe one here. `startsWith` on the origin
 * would take `https://auntie.tribetails.com.evil.test/x` for the admin site,
 * and the sign-in link would open it.
 */
internal fun httpsHostOf(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val trimmed = raw.trim()
    if (!trimmed.startsWith("https://")) return null
    val rest = trimmed.removePrefix("https://")
    val hostEnd = rest.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) rest.length else it }
    return rest.substring(0, hostEnd).lowercase().ifEmpty { null }
}

/**
 * The same link on the portal web page, for a device that cannot complete it
 * (desktop). Keeps `mode`, `oobCode` and `continueUrl`; nothing else.
 */
fun webActionUrl(link: SecureResetParams): String {
    val params = buildList {
        add("mode=" + percentEncode(link.mode))
        add("oobCode=" + percentEncode(link.oobCode))
        link.continueUrl?.let { add("continueUrl=" + percentEncode(it)) }
    }
    return "https://${EmailAction.PORTAL_HOST}/account/action?" + params.joinToString("&")
}

internal fun percentEncode(s: String): String {
    val sb = StringBuilder()
    for (b in s.encodeToByteArray()) {
        val c = b.toInt() and 0xFF
        val ch = c.toChar()
        if (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '-' || ch == '_' || ch == '.' || ch == '~') {
            sb.append(ch)
        } else {
            sb.append('%').append(c.toString(16).uppercase().padStart(2, '0'))
        }
    }
    return sb.toString()
}

/** Who a link was sent for, read from where it continues to. Drives the sign-in choice only. */
enum class EmailActionAudience { Staff, Kinfolk, Unknown }

/**
 * Anything this does not recognise is [EmailActionAudience.Unknown], which shows
 * both sign-ins and follows neither, so a target that slipped past
 * [safeContinueUrl] is never opened.
 */
fun audienceOf(continueUrl: String?): EmailActionAudience = when (httpsHostOf(continueUrl)) {
    EmailAction.STAFF_HOST -> EmailActionAudience.Staff
    EmailAction.PORTAL_HOST -> EmailActionAudience.Kinfolk
    else -> EmailActionAudience.Unknown
}

/** What went wrong with a code, in terms of what the reader can do next. */
enum class CodeProblem { Expired, Invalid, Unreachable }

/**
 * Maps a platform auth error code to a [CodeProblem], or null when the error is
 * not about the code (a weak password, say).
 *
 * Android's native codes (`ERROR_EXPIRED_ACTION_CODE`), the web SDK's
 * (`auth/expired-action-code`) and Identity Toolkit REST's (`EXPIRED_OOB_CODE`)
 * all land here. Firebase reports a used code and a garbled code the same way
 * (`INVALID_OOB_CODE`), which is why the web page and this screen share one
 * "already been used or is not valid" message for both.
 */
fun codeProblemOf(errorCode: String?): CodeProblem? = when (errorCode) {
    "ERROR_EXPIRED_ACTION_CODE", "auth/expired-action-code", "EXPIRED_OOB_CODE" -> CodeProblem.Expired
    "ERROR_INVALID_ACTION_CODE", "auth/invalid-action-code", "INVALID_OOB_CODE",
    "ERROR_USER_DISABLED", "auth/user-disabled", "USER_DISABLED",
    "ERROR_USER_NOT_FOUND", "auth/user-not-found", "EMAIL_NOT_FOUND",
    -> CodeProblem.Invalid
    else -> null
}

fun isWeakPasswordCode(errorCode: String?): Boolean =
    errorCode == "ERROR_WEAK_PASSWORD" || errorCode == "auth/weak-password" ||
        errorCode?.startsWith("WEAK_PASSWORD") == true

/** Minimal `a=b&c=d` parser with percent-decoding. The first value for a key wins. */
internal fun parseQuery(query: String): Map<String, String> {
    if (query.isBlank()) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (pair in query.split('&')) {
        if (pair.isEmpty()) continue
        val idx = pair.indexOf('=')
        val key = percentDecode(if (idx < 0) pair else pair.substring(0, idx))
        val value = if (idx < 0) "" else percentDecode(pair.substring(idx + 1))
        if (key.isNotEmpty() && key !in out) out[key] = value
    }
    return out
}

/** Decodes `%XX` sequences as UTF-8 and `+` as a space. A malformed escape is kept as typed. */
internal fun percentDecode(s: String): String {
    if ('%' !in s && '+' !in s) return s
    val bytes = ArrayList<Byte>(s.length)
    var i = 0
    while (i < s.length) {
        val ch = s[i]
        if (ch == '%' && i + 2 < s.length) {
            val hex = s.substring(i + 1, i + 3).toIntOrNull(16)
            if (hex != null) {
                bytes.add(hex.toByte())
                i += 3
                continue
            }
        }
        if (ch == '+') {
            bytes.add(' '.code.toByte())
        } else {
            ch.toString().encodeToByteArray().forEach { bytes.add(it) }
        }
        i++
    }
    return bytes.toByteArray().decodeToString()
}
