package com.kinfolk.portal.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Android implementation of [SecureResetFetcher] using [HttpURLConnection].
 *
 * Reached only from the explicit "I did not ask for this reset" choice on the
 * email action screen (#905). The body is [secureResetPayload], which carries
 * no email; the server takes the account from the code.
 *
 * HttpURLConnection (always available on Android) rather than Ktor/OkHttp, to
 * avoid a build dependency for one call.
 */
actual fun makeSecureResetFetcher(base: String): SecureResetFetcher = AndroidSecureResetFetcher(base)

private const val UNREACHABLE = "We couldn't reach Tribe Tails. Check your connection and try again."

private class AndroidSecureResetFetcher(private val base: String) : SecureResetFetcher {

    override suspend fun confirmReset(
        oobCode: String,
        newPassword: String,
        email: String,
        userAgent: String,
    ): String = withContext(Dispatchers.IO) {
        val payload = secureResetPayload(oobCode, newPassword, userAgent)
        val conn = try {
            URL("$base/confirmSecureReset").openConnection() as HttpURLConnection
        } catch (e: IOException) {
            throw SecureResetException(UNREACHABLE)
        }
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000

            val statusCode = try {
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
                conn.responseCode
            } catch (e: IOException) {
                throw SecureResetException(UNREACHABLE)
            }
            val responseText = runCatching {
                (if (statusCode in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader(Charsets.UTF_8)?.readText() ?: ""
            }.getOrDefault("")

            secureResetResult(statusCode, responseText)
        } finally {
            conn.disconnect()
        }
    }
}
