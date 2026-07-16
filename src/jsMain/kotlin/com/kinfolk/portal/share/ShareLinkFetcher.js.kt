package com.kinfolk.portal.share

import kotlinx.browser.window
import kotlinx.coroutines.await
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.w3c.fetch.RequestInit

actual fun makeShareLinkFetcher(base: String): ShareLinkFetcher = JsShareLinkFetcher(base)

private class JsShareLinkFetcher(private val base: String) : ShareLinkFetcher {
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun getShareLink(shareId: String, passcode: String?): GetShareLinkResult {
        val url = buildString {
            append(base); append("/getShareLink/"); append(shareId)
            if (!passcode.isNullOrBlank()) append("?passcode=").append(passcode)
        }
        val resp = window.fetch(url).await()
        val text = resp.text().await()
        return when (resp.status.toInt()) {
            200 -> GetShareLinkResult.Ok(json.parseToJsonElement(text) as JsonObject)
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
    ): String {
        val payload = buildJsonObject {
            put("shareToken", shareToken)
            put("taleId", taleId)
            put("body", body)
            put("guestName", guestName)
            put("guestEmail", guestEmail)
            put("recaptchaToken", recaptchaToken)
            if (parentCommentId != null) put("parentCommentId", parentCommentId)
        }
        val init = js("({})").unsafeCast<RequestInit>()
        init.method = "POST"
        @Suppress("UnsafeCastFromDynamic")
        init.headers = js("({'Content-Type': 'application/json'})")
        init.body = json.encodeToString(JsonObject.serializer(), payload)
        val resp = window.fetch("$base/addGuestKinTaleComment", init).await()
        when (resp.status.toInt()) {
            200 -> {
                val text = resp.text().await()
                val obj = json.parseToJsonElement(text) as JsonObject
                return obj["commentId"]?.jsonPrimitive?.content
                    ?: throw ShareFetchException("Guest comment: server returned no commentId.")
            }
            429 -> throw ShareFetchException("Too many comments from this email. Try again in an hour.")
            else -> throw ShareFetchException("Guest comment failed: ${resp.status}")
        }
    }
}
