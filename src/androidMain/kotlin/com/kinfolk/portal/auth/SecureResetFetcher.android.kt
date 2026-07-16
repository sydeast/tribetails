package com.kinfolk.portal.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Android implementation of [SecureResetFetcher] using [HttpURLConnection].
 *
 * The secure-reset flow is primarily a web flow (kinfolk clicks an email link
 * in a browser), but Android deep-links can land here if the email client
 * opens the URL in-app.
 *
 * Uses HttpURLConnection (always available on Android) rather than Ktor/OkHttp
 * to avoid adding a build dependency. The payload is hand-serialized; no full
 * JSON library needed for this single call.
 */
actual fun makeSecureResetFetcher(base: String): SecureResetFetcher = AndroidSecureResetFetcher(base)

private class AndroidSecureResetFetcher(private val base: String) : SecureResetFetcher {

    override suspend fun confirmReset(
        oobCode: String,
        newPassword: String,
        email: String,
        userAgent: String,
    ): String = withContext(Dispatchers.IO) {
        val payload = buildJsonPayload(oobCode, newPassword, email, userAgent)
        val url = URL("$base/confirmSecureReset")

        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000

            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }

            val statusCode = conn.responseCode
            val responseText = runCatching {
                (if (statusCode in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.readText() ?: ""
            }.getOrDefault("")

            when (statusCode) {
                200 -> {
                    val incidentId = extractJsonField(responseText, "incidentId")
                        ?: throw SecureResetException("Server returned no incidentId.")
                    incidentId
                }
                400 -> {
                    val detail = extractJsonField(responseText, "error") ?: "invalid_request"
                    throw SecureResetException(
                        when (detail) {
                            "missing_required"   -> "Required fields are missing. Please reload and try again."
                            "password_too_short" -> "Password must be at least 8 characters."
                            "invalid_email"      -> "Email address is invalid."
                            "reset_failed"       -> "This link has expired or already been used. Request a new reset email."
                            else                 -> "Request failed: $detail"
                        }
                    )
                }
                502 -> throw SecureResetException("Could not reach authentication server. Please try again shortly.")
                503 -> throw SecureResetException("Server configuration error. Please contact support.")
                else -> throw SecureResetException("Unexpected error ($statusCode). Please try again.")
            }
        } finally {
            conn.disconnect()
        }
    }

    /** Minimal JSON string escaping for hand-built payload. */
    private fun jsonStr(s: String): String {
        val escaped = s.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
        return "\"$escaped\""
    }

    private fun buildJsonPayload(oobCode: String, newPassword: String, email: String, userAgent: String): String =
        """{"oobCode":${jsonStr(oobCode)},"newPassword":${jsonStr(newPassword)},"email":${jsonStr(email)},"userAgent":${jsonStr(userAgent)}}"""

    /** Extracts a top-level string field from a JSON object. */
    private fun extractJsonField(json: String, key: String): String? {
        val pattern = """"$key"\s*:\s*"([^"]*)"""".toRegex()
        return pattern.find(json)?.groupValues?.getOrNull(1)
    }
}
