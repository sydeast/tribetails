package com.kinfolk.portal.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
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

private class JvmSecureResetFetcher(private val base: String) : SecureResetFetcher {
    private val client = HttpClient(CIO)
    private val json = Json { ignoreUnknownKeys = true }

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
        val resp = client.post("$base/confirmSecureReset") {
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
