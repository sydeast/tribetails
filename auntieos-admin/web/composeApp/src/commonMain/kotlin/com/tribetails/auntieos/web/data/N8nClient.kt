package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.post
import io.ktor.client.request.header
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.URLProtocol
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.SerialName
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/**
 * Talks to Auntie's n8n webhooks at n8n.tribetails.com (Cloudflare tunnel → Debian docker).
 * The auntie.tribetails.com subdomain is reserved for the finished app, so the web
 * bundle no longer shares an origin with n8n - host must be set explicitly.
 * Endpoints:
 *   POST /webhook/auntie-generate          → generate copy + return draft id
 *   POST /webhook/auntie-update-profiles   → fire-and-forget profile refresh
 *
 * communication_type contract (n8n workflow SIg2KsWn0oyRkSzR):
 *   sms, email, visit_report, social_post, blog_post, general
 */
class N8nClient {
    private val codec = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val http = HttpClient {
        install(ContentNegotiation) {
            json(codec)
        }
        defaultRequest {
            url {
                protocol = URLProtocol.HTTPS
                host = "n8n.tribetails.com"
            }
        }
    }

    /**
     * Generate Auntie copy. When [useFunction] is true (the default; gated at the
     * call site by FeatureFlags.communicateGenerateViaFunction), routes to the
     * admin-only Firebase `generate` function at auntieos-ttpc.web.app/api/generate
     * with a Bearer admin token. Otherwise the legacy (now-retired) n8n webhook.
     * Request/response are byte-compatible across both backends. The function
     * returns a full GenerateResponse even on error (error field set), so callers
     * keep their existing `resp.error` handling.
     */
    suspend fun generate(req: GenerateRequest, useFunction: Boolean = true): GenerateResponse {
        if (!useFunction) {
            return http.post("/webhook/auntie-generate") {
                contentType(ContentType.Application.Json)
                setBody(req)
            }.body()
        }
        val idToken = AuthClient().idToken(forceRefresh = false)
            ?: throw IllegalStateException("Admin sign-in required before generate")
        val response = http.post("https://auntieos-ttpc.web.app/api/generate") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer $idToken")
            setBody(req)
        }
        val rawBody = response.bodyAsText()
        val parsed = runCatching { codec.decodeFromString<GenerateResponse>(rawBody) }.getOrNull()
        if (parsed != null) return parsed
        if (!response.status.isSuccess()) {
            throw IllegalStateException("generate failed (${response.status.value}): ${rawBody.take(220)}")
        }
        throw IllegalStateException("generate returned non-JSON body")
    }

    suspend fun pingProfileUpdate(draftId: String, kinfolkId: String?) {
        runCatching {
            http.post("/webhook/auntie-update-profiles") {
                contentType(ContentType.Application.Json)
                setBody(ProfileUpdateRequest(
                    triggerSource = "generated_draft",
                    rowId         = draftId,
                    kinfolkId     = kinfolkId,
                ))
            }
        }
    }

    suspend fun sendMessage(req: SendMessageRequest): SendMessageResponse {
        val idToken = AuthClient().idToken(forceRefresh = false)
            ?: throw IllegalStateException("Admin sign-in required before sendMessage")
        val response = http.post("/api/send-message") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer $idToken")
            setBody(req)
        }
        val rawBody = response.bodyAsText()
        val parsed = runCatching { codec.decodeFromString<SendMessageResponse>(rawBody) }.getOrNull()
        if (!response.status.isSuccess()) {
            val detail = parsed?.error ?: parsed?.message ?: rawBody.take(220)
            throw IllegalStateException("sendMessage failed (${response.status.value}): $detail")
        }
        return parsed ?: throw IllegalStateException("sendMessage returned non-JSON body")
    }
}

@Serializable
data class GenerateRequest(
    val communication_type: CommunicationType,
    val recipient: String,
    val raw_notes: String,
    val tone_hint: String? = null,
    val max_length: String? = null,
    /** On regenerate: an opener the reader rejected; the generator must not reuse it. */
    val avoid_opening: String? = null,
)

@Serializable
enum class CommunicationType {
    @SerialName("sms") SMS,
    @SerialName("email") EMAIL,
    @SerialName("visit_report") VISIT_REPORT,
    @SerialName("social_post") SOCIAL_POST,
    @SerialName("blog_post") BLOG_POST,
    @SerialName("general") GENERAL,
}

@Serializable
data class GenerateResponse(
    val generated_copy: String,
    val communication_type: String,
    val kinfolk_name: String? = null,
    val kinfolk_id: String?  = null,
    val draft_id: String?    = null,
    val model: String?       = null,
    val error: String?       = null,
)

@Serializable
private data class ProfileUpdateRequest(
    val triggerSource: String,
    val rowId: String,
    val kinfolkId: String?,
)

@Serializable
data class SendMessageRequest(
    val channel: String,
    val message_body: String,
    val kinfolk_id: String? = null,
    val recipient_phone: String? = null,
    val recipient_email: String? = null,
)

@Serializable
data class SendMessageResponse(
    val ok: Boolean? = null,
    val status: String? = null,
    val message: String? = null,
    val error: String? = null,
    val provider_error: String? = null,
    val sid: String? = null,
    val id: String? = null,
    val message_sid: String? = null,
    val twilioMessageSid: String? = null,
)
