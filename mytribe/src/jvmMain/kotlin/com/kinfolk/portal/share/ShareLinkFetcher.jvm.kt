package com.kinfolk.portal.share

import com.kinfolk.portal.firebase.FirebaseRestConfig
import com.kinfolk.portal.firebase.RestEndpoints
import com.kinfolk.portal.firebase.RestHttp
import io.ktor.client.HttpClient
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

/**
 * #889 review: [base] is the caller-supplied production default
 * (DEFAULT_SHARE_BASE). This jvm actual used to build its own
 * HttpClient(CIO) and always post/get against that hardcoded prod host, the
 * same hole SecureResetFetcher.jvm.kt had. It now shares RestHttp.client
 * (which carries the :jvmTest network guard) and, when an emulator is
 * active, routes through FirebaseRestConfig.functionsBase() instead of the
 * caller-supplied base.
 *
 * [client]/[endpoints] are injectable so a test can assert the outgoing URL
 * against a MockEngine without touching process env or a real socket.
 */
internal class JvmShareLinkFetcher(
    private val base: String,
    private val client: HttpClient = RestHttp.client,
    private val endpoints: RestEndpoints = FirebaseRestConfig,
) : ShareLinkFetcher {
    private val json = Json { ignoreUnknownKeys = true }

    // #889 review round 3, item 3: gates on the Functions emulator switch
    // specifically, not emulatorActive. See JvmSecureResetFetcher for why.
    private fun resolvedBase(): String = if (endpoints.FUNCTIONS_EMULATOR_HOST != null) endpoints.functionsBase() else base

    override suspend fun getShareLink(shareId: String, passcode: String?): GetShareLinkResult {
        val url = buildString {
            append(resolvedBase()); append("/getShareLink/"); append(shareId)
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
        val resp: HttpResponse = client.post("${resolvedBase()}/addGuestKinTaleComment") {
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
