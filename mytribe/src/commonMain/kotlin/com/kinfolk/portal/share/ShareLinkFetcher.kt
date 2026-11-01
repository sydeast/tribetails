package com.kinfolk.portal.share

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Anonymous HTTP fetcher for the public share endpoints — distinct from
 * [com.kinfolk.portal.firebase.FunctionsClient] (which is auth-required).
 *
 * Two endpoints in scope:
 *  - `GET  {base}/getShareLink/{shareId}` (no passcode yet), or
 *    `POST {base}/getShareLink/{shareId}` with `{"passcode": "..."}` in the body
 *    → 200 scrubbedPayload (+ `unlockToken` after a passcode) | 401 passcode-required
 *      | 404 not-found | 410 expired
 *  - `POST {base}/addGuestKinTaleComment` (with `unlockToken` on a protected share)
 *    → 200 commentId | 401 passcode-required | 429 rate-limited | 4xx validation
 *
 * #1331: the passcode is never put in a URL. It used to ride as `?passcode=`,
 * which landed it in Cloud Functions request logs; the server now refuses
 * that form. [shareLinkRequest] builds the request for every actual so the
 * rule lives in one place and is tested once (commonTest).
 *
 * #1332: a guest note on a passcode-protected share must carry proof of the
 * unlock. The token `getShareLink` returns after a right passcode is that
 * proof; [guestCommentBody] puts it in the comment body.
 *
 * Per `feedback_fail_loud_policy.md`: errors throw [ShareFetchException] so
 * the UI can render a visible banner. Do NOT silently swallow.
 *
 * commonMain is interface-only; platforms provide HTTP via [makeShareLinkFetcher].
 * jsMain and jvmMain ship real implementations; the Android actual throws,
 * since the share viewer is web-only (public URL → browser).
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
        unlockToken: String?,
    ): String
}

expect fun makeShareLinkFetcher(base: String = DEFAULT_SHARE_BASE): ShareLinkFetcher

const val DEFAULT_SHARE_BASE = "https://us-central1-auntieos-ttpc.cloudfunctions.net"

sealed class GetShareLinkResult {
    /**
     * [unlockToken] is set when this read verified a typed passcode. Pass it to
     * [ShareLinkFetcher.postGuestComment]; it lasts an hour.
     */
    data class Ok(val payload: JsonObject, val unlockToken: String? = null) : GetShareLinkResult()
    object PasscodeRequired : GetShareLinkResult()
    object NotFound : GetShareLinkResult()
    object Expired : GetShareLinkResult()
}

class ShareFetchException(message: String) : RuntimeException(message)

/** One outgoing `getShareLink` request: [body] is null for a GET. */
data class ShareLinkRequest(val method: String, val url: String, val body: JsonObject?)

/**
 * The `getShareLink` request for [shareId]. With no passcode it is the plain
 * GET; with one it is a POST whose JSON body carries the passcode. The URL is
 * the same either way and never has a query string.
 */
fun shareLinkRequest(base: String, shareId: String, passcode: String?): ShareLinkRequest {
    val url = "$base/getShareLink/$shareId"
    return if (passcode.isNullOrBlank()) {
        ShareLinkRequest("GET", url, null)
    } else {
        ShareLinkRequest("POST", url, buildJsonObject { put("passcode", passcode) })
    }
}

/**
 * Splits a 200 `getShareLink` reply into the payload the screen renders and
 * the unlock token it keeps for the comment form.
 */
fun shareLinkOk(reply: JsonObject): GetShareLinkResult.Ok {
    val token = (reply["unlockToken"] as? JsonPrimitive)?.contentOrNull?.ifBlank { null }
    return GetShareLinkResult.Ok(JsonObject(reply - "unlockToken"), token)
}

/** The `addGuestKinTaleComment` JSON body. */
fun guestCommentBody(
    shareToken: String,
    taleId: String,
    body: String,
    guestName: String,
    guestEmail: String,
    recaptchaToken: String,
    parentCommentId: String?,
    unlockToken: String?,
): JsonObject = buildJsonObject {
    put("shareToken", shareToken)
    put("taleId", taleId)
    put("body", body)
    put("guestName", guestName)
    put("guestEmail", guestEmail)
    put("recaptchaToken", recaptchaToken)
    if (parentCommentId != null) put("parentCommentId", parentCommentId)
    if (!unlockToken.isNullOrBlank()) put("unlockToken", unlockToken)
}

/** What a guest sees when a note is refused for want of the unlock. */
const val GUEST_NOTE_LOCKED_MESSAGE =
    "This tale is locked again. Reload the page, enter the passcode, then send your note."

/** The shared `addGuestKinTaleComment` reply handling for every actual. */
fun guestCommentResult(status: Int, reply: () -> JsonObject): String = when (status) {
    200 -> reply()["commentId"]?.jsonPrimitive?.contentOrNull
        ?: throw ShareFetchException("Guest comment: server returned no commentId.")
    401 -> throw ShareFetchException(GUEST_NOTE_LOCKED_MESSAGE)
    429 -> throw ShareFetchException("Too many comments from this email. Try again in an hour.")
    else -> throw ShareFetchException("Guest comment failed: $status")
}
