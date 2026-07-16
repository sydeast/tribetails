package com.kinfolk.portal.auth

import kotlinx.browser.window
import kotlinx.coroutines.await
import org.w3c.fetch.RequestInit

actual fun makeSecureResetFetcher(base: String): SecureResetFetcher = JsSecureResetFetcher(base)

private class JsSecureResetFetcher(private val base: String) : SecureResetFetcher {

    override suspend fun confirmReset(
        oobCode: String,
        newPassword: String,
        email: String,
        userAgent: String,
    ): String {
        val payload = """{"oobCode":${jsonStr(oobCode)},"newPassword":${jsonStr(newPassword)},"email":${jsonStr(email)},"userAgent":${jsonStr(userAgent)}}"""

        val init = js("({})").unsafeCast<RequestInit>()
        init.method = "POST"
        @Suppress("UnsafeCastFromDynamic")
        init.headers = js("({'Content-Type': 'application/json'})")
        init.body = payload

        val resp = window.fetch("$base/confirmSecureReset", init).await()
        val text = resp.text().await()

        when (resp.status.toInt()) {
            200 -> {
                // Extract incidentId from JSON without a full parser dependency
                val incidentId = extractJsonField(text, "incidentId")
                    ?: throw SecureResetException("Server returned no incidentId in response.")
                return incidentId
            }
            400 -> {
                val detail = extractJsonField(text, "error") ?: "invalid_request"
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
            else -> throw SecureResetException("Unexpected error (${resp.status}). Please try again.")
        }
    }

    /** Minimal JSON string escaping for embedding in a manual JSON literal. */
    private fun jsonStr(s: String): String {
        val escaped = s.replace("\\", "\\\\").replace("\"", "\\\"")
            .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
        return "\"$escaped\""
    }

    /** Extracts a top-level string field from a JSON object without pulling a full library. */
    private fun extractJsonField(json: String, key: String): String? {
        val pattern = """"$key"\s*:\s*"([^"]*)"""".toRegex()
        return pattern.find(json)?.groupValues?.getOrNull(1)
    }
}
