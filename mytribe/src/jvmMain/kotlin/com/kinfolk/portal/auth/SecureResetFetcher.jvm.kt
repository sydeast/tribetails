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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

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
 * against a MockEngine without touching process env or a real socket. The
 * request payload is unchanged here; PR #903 (#892) owns that shape.
 */
internal class JvmSecureResetFetcher(
    private val base: String,
    private val client: HttpClient = RestHttp.client,
    private val endpoints: RestEndpoints = FirebaseRestConfig,
) : SecureResetFetcher {
    private val json = Json { ignoreUnknownKeys = true }

    private fun resolvedBase(): String = if (endpoints.emulatorActive) endpoints.functionsBase() else base

    override suspend fun confirmReset(
        oobCode: String,
        newPassword: String,
        email: String,
        userAgent: String,
    ): String {
        val payload = buildJsonObject {
            put("oobCode", oobCode)
            put("newPassword", newPassword)
            put("email", email)
            put("userAgent", userAgent)
        }
        val resp = client.post("${resolvedBase()}/confirmSecureReset") {
            headers { append(HttpHeaders.ContentType, "application/json") }
            setBody(json.encodeToString(JsonObject.serializer(), payload))
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
