package com.kinfolk.portal.util

import com.kinfolk.portal.auth.parseEmailActionUrl
import com.kinfolk.portal.auth.parseQuery
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
    // #905: the hand-rolled parser this used to call lived beside the old
    // secure-reset parsing and went with it. This is the same query parser the
    // email action links use, which also decodes `%XX` and `+`.
    return parseQuery(loc.search.removePrefix("?"))["invite"]?.takeIf { it.isNotBlank() }
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
 * #905: a Firebase email action link at `/account/secure-reset` or
 * `/account/action`, parsed by the shared [parseEmailActionUrl] (no `email`
 * param required; the screen reads the account from the verified code).
 */
actual fun readInitialSecureResetParams(): SecureResetParams? = parseEmailActionUrl(window.location.href)

private fun parseSegment(s: String, prefix: String): String? {
    val parts = s.trim('/').split("/")
    if (parts.size >= 2 && parts[0] == prefix) {
        val id = parts[1]
        if (id.isNotBlank()) return id
    }
    return null
}
