package com.kinfolk.portal.share

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

actual fun makeShareLinkFetcher(base: String): ShareLinkFetcher = JvmShareLinkFetcher(base)

private class JvmShareLinkFetcher(private val base: String) : ShareLinkFetcher {
    private val client = HttpClient(CIO)
    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun getShareLink(shareId: String, passcode: String?): GetShareLinkResult {
        val url = buildString {
            append(base); append("/getShareLink/"); append(shareId)
            if (!passcode.isNullOrBlank()) append("?passcode=").append(passcode)
        }
        val resp: HttpResponse = client.get(url)
        val text = resp.bodyAsText()
        return when (resp.status) {
            HttpStatusCode.OK            -> GetShareLinkResult.Ok(json.parseToJsonElement(text) as JsonObject)
            HttpStatusCode.Unauthorized  -> GetShareLinkResult.PasscodeRequired
            HttpStatusCode.NotFound      -> GetShareLinkResult.NotFound
            HttpStatusCode.Gone          -> GetShareLinkResult.Expired
            else -> throw ShareFetchException("Share fetch failed: ${resp.status.value}")
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
        val resp: HttpResponse = client.post("$base/addGuestKinTaleComment") {
            headers { append(HttpHeaders.ContentType, "application/json") }
            setBody(json.encodeToString(JsonObject.serializer(), payload))
        }
        val text = resp.bodyAsText()
        when (resp.status) {
            HttpStatusCode.OK -> {
                val obj = json.parseToJsonElement(text) as JsonObject
                return obj["commentId"]?.jsonPrimitive?.content
                    ?: throw ShareFetchException("Guest comment: server returned no commentId.")
            }
            HttpStatusCode.TooManyRequests ->
                throw ShareFetchException("Too many comments from this email. Try again in an hour.")
            else -> throw ShareFetchException("Guest comment failed: ${resp.status.value}")
        }
    }
}
