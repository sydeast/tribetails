package com.kinfolk.portal.auth

import com.kinfolk.portal.firebase.FirebaseRestConfig
import com.kinfolk.portal.firebase.RestEndpoints
import com.kinfolk.portal.firebase.RestHttp
import io.ktor.client.HttpClient
import io.ktor.client.request.headers
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

actual fun makeSecureResetFetcher(base: String): SecureResetFetcher = JvmSecureResetFetcher(base)

/**
 * #889 review: [base] is the caller-supplied production default
 * (DEFAULT_SECURE_RESET_BASE, common to jvm/android/js). This jvm actual used
 * to build its own HttpClient(CIO) and always post to that hardcoded prod
 * host, so a JVM test that reached confirmReset would hit production. It now
 * shares RestHttp.client (which carries the :jvmTest network guard) and, when
 * an emulator is active, routes through FirebaseRestConfig.functionsBase()
 * instead of the caller-supplied base. An explicit prod base still wins when
 * no emulator is configured.
 *
 * [client]/[endpoints] are injectable so a test can assert the outgoing URL
 * against a MockEngine without touching process env or a real socket.
 *
 * The body is [secureResetPayload], the same three keys Android and web post.
 * It used to add an `email` field of its own. The server has derived the
 * account from the code and ignored a client-sent address since #903, and since
 * #905 desktop cannot reach this call at all (its auth backend cannot check a
 * code, so the screen sends the reader to a browser), so nothing was wrong on
 * the wire. It was one body out of three describing a contract that no longer
 * existed (#933 item 4).
 */
internal class JvmSecureResetFetcher(
    private val base: String,
    private val client: HttpClient = RestHttp.client,
    private val endpoints: RestEndpoints = FirebaseRestConfig,
) : SecureResetFetcher {
    private val json = Json { ignoreUnknownKeys = true }

    // #889 review round 3, item 3: gates on the Functions emulator switch
    // specifically, not emulatorActive. With only FIRESTORE_EMULATOR_HOST
    // set, emulatorActive was true but no Functions emulator exists, so this
    // used to send the new password to functionsBase() anyway; if
    // GCLOUD_PROJECT was also set to a demo- id, that host did not even
    // exist. functionsBase's own production branch is unaffected either way
    // (it always uses the real project id there), but there is no reason to
    // route this call through it when nothing said the Functions emulator
    // was up.
    private fun resolvedBase(): String = if (endpoints.FUNCTIONS_EMULATOR_HOST != null) endpoints.functionsBase() else base

    override suspend fun confirmReset(
        oobCode: String,
        newPassword: String,
        email: String,
        userAgent: String,
    ): String {
        val resp = client.post("${resolvedBase()}/confirmSecureReset") {
            headers { append(HttpHeaders.ContentType, "application/json") }
            setBody(secureResetPayload(oobCode, newPassword, userAgent))
        }
        val text = resp.bodyAsText()
        return when (resp.status) {
            HttpStatusCode.OK -> {
                val obj = json.parseToJsonElement(text) as? JsonObject
                    ?: throw SecureResetException("Server response was not a JSON object.")
                obj["incidentId"]?.jsonPrimitive?.content
                    ?: throw SecureResetException("Server returned no incidentId.")
            }
            HttpStatusCode.BadRequest -> {
                val obj = json.parseToJsonElement(text) as? JsonObject
                val detail = obj?.get("error")?.jsonPrimitive?.content ?: "invalid_request"
                throw SecureResetException(
                    when (detail) {
                        "missing_required"   -> "Required fields are missing. Please reload and try again."
                        "password_too_short" -> "Password must be at least 8 characters."
                        "reset_failed"       -> "This link has expired or already been used. Request a new reset email."
                        else                 -> "Request failed: $detail"
                    }
                )
            }
            HttpStatusCode.BadGateway -> throw SecureResetException("Could not reach authentication server. Please try again shortly.")
            else -> throw SecureResetException("Unexpected error (${resp.status.value}). Please try again.")
        }
    }
}
