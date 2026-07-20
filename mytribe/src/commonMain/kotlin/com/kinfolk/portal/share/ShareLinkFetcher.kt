package com.kinfolk.portal.share

import kotlinx.serialization.json.JsonObject

/**
 * Anonymous HTTP fetcher for the public share endpoints — distinct from
 * [com.kinfolk.portal.firebase.FunctionsClient] (which is auth-required).
 *
 * Two endpoints in scope:
 *  - `GET  {base}/getShareLink/{shareId}?passcode=...`
 *    → 200 scrubbedPayload | 401 passcode-required | 404 not-found | 410 expired
 *  - `POST {base}/addGuestKinTaleComment`
 *    → 200 commentId | 429 rate-limited | 4xx validation
 *
 * Per `feedback_fail_loud_policy.md`: errors throw [ShareFetchException] so
 * the UI can render a visible banner. Do NOT silently swallow.
 *
 * commonMain is interface-only; platforms provide HTTP via [makeShareLinkFetcher].
 * Today only jsMain ships a real implementation — Android/JVM stubs throw, since
 * the share viewer is web-only (public URL → browser).
 */
interface ShareLinkFetcher {
    suspend fun getShareLink(shareId: String, passcode: String?): GetShareLinkResult
    suspend fun postGuestComment(
        shareToken: String,
        taleId: String,
        body: String,
        guestName: String,
        guestEmail: String,
        recaptchaToken: String,
        parentCommentId: String?,
    ): String
}

expect fun makeShareLinkFetcher(base: String = DEFAULT_SHARE_BASE): ShareLinkFetcher

const val DEFAULT_SHARE_BASE = "https://us-central1-auntieos-ttpc.cloudfunctions.net"

sealed class GetShareLinkResult {
    data class Ok(val payload: JsonObject) : GetShareLinkResult()
    object PasscodeRequired : GetShareLinkResult()
    object NotFound : GetShareLinkResult()
    object Expired : GetShareLinkResult()
}

class ShareFetchException(message: String) : RuntimeException(message)
