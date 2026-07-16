package com.kinfolk.portal.util

import kotlinx.browser.window

/**
 * Reads from URL fragment `#/claim/<id>`, pathname `/claim/<id>`, or the
 * `?invite=<id>` query param. The query form is what every invite email sends
 * (functions build `${CLAIM_LINK_BASE_URL}?invite=${id}`), so it must parse
 * here or the claim screen never mounts for invited kinfolk.
 */
actual fun readInitialClaimInviteId(): String? {
    val loc = window.location
    val hash = loc.hash.removePrefix("#")
    parseClaim(hash)?.let { return it }
    val path = loc.pathname
    parseClaim(path)?.let { return it }
    return parseQueryString(loc.search.removePrefix("?"))["invite"]?.takeIf { it.isNotBlank() }
}

private fun parseClaim(s: String): String? = parseSegment(s, "claim")

actual fun readInitialShareToken(): String? {
    val loc = window.location
    val hash = loc.hash.removePrefix("#")
    parseSegment(hash, "share")?.let { return it }
    val path = loc.pathname
    return parseSegment(path, "share")
}

/**
 * Parses `/account/secure-reset` with `oobCode` and `email` query params.
 *
 * The reset link in the Firebase email template is:
 *   https://tribetails.com/account/secure-reset?source=unauthorized_attempt&email=%EMAIL%
 * The oobCode arrives as an additional query param appended by the email CTA
 * or the MyTribe UI (passed through from the original Firebase reset link).
 *
 * Triggers when pathname is `/account/secure-reset` (hash or plain).
 */
actual fun readInitialSecureResetParams(): SecureResetParams? {
    val loc = window.location
    val path = loc.pathname.trimEnd('/')
    val hashPath = loc.hash.removePrefix("#").trimEnd('/')
    val isSecureReset = path == "/account/secure-reset" || hashPath == "/account/secure-reset"
    if (!isSecureReset) return null

    val search = loc.search.removePrefix("?")
    val params = parseQueryString(search)
    val oobCode = params["oobCode"]?.takeIf { it.isNotBlank() } ?: return null

    // Prefer email as a direct param; fall back to parsing it from continueUrl.
    // Firebase appends the ActionCodeSettings.url as continueUrl=<encoded-url>, and
    // that encoded URL carries ?email=<encoded-email>.
    val email = params["email"]?.takeIf { it.isNotBlank() }
        ?: params["continueUrl"]
            ?.takeIf { it.isNotBlank() }
            ?.let { continueUrl ->
                val query = continueUrl.substringAfter("?", "")
                parseQueryString(query)["email"]?.takeIf { it.isNotBlank() }
            }
        ?: return null

    return SecureResetParams(oobCode = oobCode, email = email)
}

/** Minimal query-string parser: `key=value&key2=value2` → Map. */
private fun parseQueryString(query: String): Map<String, String> {
    if (query.isBlank()) return emptyMap()
    return query.split("&").mapNotNull { pair ->
        val idx = pair.indexOf('=')
        if (idx <= 0) null
        else pair.substring(0, idx) to decodeURIComponent(pair.substring(idx + 1))
    }.toMap()
}

private fun decodeURIComponent(encoded: String): String {
    return try {
        js("decodeURIComponent(encoded)").toString()
    } catch (_: Throwable) {
        encoded
    }
}

private fun parseSegment(s: String, prefix: String): String? {
    val parts = s.trim('/').split("/")
    if (parts.size >= 2 && parts[0] == prefix) {
        val id = parts[1]
        if (id.isNotBlank()) return id
    }
    return null
}
