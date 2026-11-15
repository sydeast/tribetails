package com.tribetails.auntieos.web.data

import com.tribetails.auntieos.web.observability.runCatchingCancellable
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
import kotlin.coroutines.cancellation.CancellationException
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
class N8nClient internal constructor(private val http: HttpClient) {

    // #867: built by the shared factory, so it has timeouts and the desktop test
    // network guard. Two of these calls send no token, so nothing else stops them.
    constructor() : this(n8nHttpClient(requestTimeoutMs = 120_000L, protocol = URLProtocol.HTTPS, host = "n8n.tribetails.com"))

    private val codec = n8nCodec

    /**
     * #867 review: a failed request reads the way the REST layer's do. A timeout
     * becomes [AUNTIE_TIMEOUT_MESSAGE] instead of Ktor's text, which the callers
     * show after "Generate failed:". Cancellation still propagates.
     */
    private suspend fun <T> readable(fallback: String, block: suspend () -> T): T =
        try {
            block()
        } catch (c: kotlin.coroutines.cancellation.CancellationException) {
            throw c
        } catch (c: CancellationException) {
            throw c
        } catch (e: Exception) {
            val message = e.transportMessage(fallback)
            if (message == AUNTIE_TIMEOUT_MESSAGE) throw IllegalStateException(message, e) else throw e
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
            return readable("generate failed") {
                http.post("/webhook/auntie-generate") {
                    contentType(ContentType.Application.Json)
                    setBody(req)
                }.body()
            }
        }
        val idToken = AuthClient().idToken(forceRefresh = false)
            ?: throw IllegalStateException(GENERATE_SIGN_IN_COPY)
        val (response, rawBody) = readable("generate failed") {
            val r = http.post("https://auntieos-ttpc.web.app/api/generate") {
                contentType(ContentType.Application.Json)
                header("Authorization", "Bearer $idToken")
                setBody(req)
            }
            r to r.bodyAsText()
        }
        val parsed = runCatchingCancellable { codec.decodeFromString<GenerateResponse>(rawBody) }.getOrNull()
        if (parsed != null) return parsed
        // #2052: a reply that is not the generator's own shape is never shown.
        // Its status and body are a fault report, not words for the Auntie.
        println("generate: unreadable reply (${response.status.value})")
        throw IllegalStateException(GENERATE_FAILED_COPY)
    }

    suspend fun pingProfileUpdate(draftId: String, kinfolkId: String?) {
        runCatchingCancellable {
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
        val (response, rawBody) = readable("sendMessage failed") {
            val r = http.post("/api/send-message") {
                contentType(ContentType.Application.Json)
                header("Authorization", "Bearer $idToken")
                setBody(req)
            }
            r to r.bodyAsText()
        }
        val parsed = runCatchingCancellable { codec.decodeFromString<SendMessageResponse>(rawBody) }.getOrNull()
        if (!response.status.isSuccess()) {
            val detail = parsed?.error ?: parsed?.message ?: rawBody.take(220)
            throw IllegalStateException("sendMessage failed (${response.status.value}): $detail")
        }
        return parsed ?: throw IllegalStateException("sendMessage returned non-JSON body")
    }
}

private val n8nCodec = Json {
    ignoreUnknownKeys = true
    isLenient = true
}

/** The n8n client's HTTP client. Relative paths resolve against [protocol]://[host]:[port]; a test points it at a local socket. */
internal fun n8nHttpClient(requestTimeoutMs: Long, protocol: URLProtocol, host: String, port: Int? = null): HttpClient =
    auntieHttpClient(requestTimeoutMs = requestTimeoutMs) {
        install(ContentNegotiation) {
            json(n8nCodec)
        }
        defaultRequest {
            url {
                this.protocol = protocol
                this.host = host
                if (port != null) this.port = port
            }
        }
    }

/** What a failed generate says when there is nothing better to say (#2052). */
const val GENERATE_FAILED_COPY = "Auntie could not write a draft just now. Try again in a moment."
const val GENERATE_SIGN_IN_COPY = "Sign in again, then ask Auntie."
@Serializable
data class GenerateRequest(
    val communication_type: CommunicationType,
    val recipient: String,
    val raw_notes: String,
    val tone_hint: String? = null,
    val max_length: String? = null,
    /** On regenerate: an opener the reader rejected; the generator must not reuse it. */
    val avoid_opening: String? = null,
    /**
     * The household's own id, when the caller holds it. The server then reads
     * that record instead of matching [recipient] by name. Omitted when null.
     */
    val kinfolk_id: String? = null,
    /**
     * #2079: the visit a KinTale recaps. With it the server writes from that
     * visit's own record (its Kin, its KinCare, its times) and from nothing
     * else about the household. Omitted when null.
     */
    val session_id: String? = null,
    /**
     * #2052: the care tasks ticked on the composer. They live in the form until
     * the tale is saved, so the server cannot read them; a task not listed is
     * one the draft may not claim was done. Omitted when null.
     */
    val care_tasks: List<GenerateCareTask>? = null,
)
/** One ticked care task: its label, and the Kin it was for (blank for a once-a-visit task). */
@Serializable
data class GenerateCareTask(
    val text: String,
    val kin_name: String = "",
)

@Serializable
enum class CommunicationType {
    @SerialName("sms") SMS,
    @SerialName("email") EMAIL,
    @SerialName("push") PUSH,
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
