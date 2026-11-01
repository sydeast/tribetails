package com.kinfolk.portal.share

import kotlinx.browser.window
import kotlinx.coroutines.await
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.w3c.fetch.RequestInit

actual fun makeShareLinkFetcher(base: String): ShareLinkFetcher = JsShareLinkFetcher(base)

private class JsShareLinkFetcher(private val base: String) : ShareLinkFetcher {
    private val json = Json { ignoreUnknownKeys = true }

    private fun jsonPost(body: JsonObject): RequestInit {
        val init = js("({})").unsafeCast<RequestInit>()
        init.method = "POST"
        @Suppress("UnsafeCastFromDynamic")
        init.headers = js("({'Content-Type': 'application/json'})")
        init.body = json.encodeToString(JsonObject.serializer(), body)
        return init
    }

    override suspend fun getShareLink(shareId: String, passcode: String?): GetShareLinkResult {
        // #1331: the passcode goes in a POST body, never the URL.
        // shareLinkRequest (commonMain) builds both shapes and is tested there.
        val request = shareLinkRequest(base, shareId, passcode)
        // RequestInit() is not decoration: `fetch` used to declare its `init`
        // parameter with a default and no longer does, so the bare one-argument
        // call this replaced stopped resolving under Kotlin 2.4 (#507).
        val init = request.body?.let { jsonPost(it) } ?: RequestInit()
        val resp = window.fetch(request.url, init).await()
        val text = resp.text().await()
        return when (resp.status.toInt()) {
            200 -> shareLinkOk(json.parseToJsonElement(text) as JsonObject)
            401 -> GetShareLinkResult.PasscodeRequired
            404 -> GetShareLinkResult.NotFound
            410 -> GetShareLinkResult.Expired
            else -> throw ShareFetchException("Share fetch failed: ${resp.status}")
        }
    }

    override suspend fun postGuestComment(
        shareToken: String,
        taleId: String,
        body: String,
        guestName: String,
        guestEmail: String,
        recaptchaToken: String,
        parentCommentId: String?,
        unlockToken: String?,
    ): String {
        val payload = guestCommentBody(
            shareToken, taleId, body, guestName, guestEmail, recaptchaToken, parentCommentId, unlockToken,
        )
        val resp = window.fetch("$base/addGuestKinTaleComment", jsonPost(payload)).await()
        val text = resp.text().await()
        return guestCommentResult(resp.status.toInt()) { json.parseToJsonElement(text) as JsonObject }
    }
}
