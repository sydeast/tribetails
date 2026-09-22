package com.kinfolk.portal.auth

import kotlinx.browser.window
import kotlinx.coroutines.await
import org.w3c.fetch.RequestInit

actual fun makeSecureResetFetcher(base: String): SecureResetFetcher = JsSecureResetFetcher(base)

/** Body from [secureResetPayload] (no email), result from [secureResetResult]. */
private class JsSecureResetFetcher(private val base: String) : SecureResetFetcher {

    override suspend fun confirmReset(
        oobCode: String,
        newPassword: String,
        email: String,
        userAgent: String,
    ): String {
        val init = js("({})").unsafeCast<RequestInit>()
        init.method = "POST"
        @Suppress("UnsafeCastFromDynamic")
        init.headers = js("({'Content-Type': 'application/json'})")
        init.body = secureResetPayload(oobCode, newPassword, userAgent)

        val resp = try {
            window.fetch("$base/confirmSecureReset", init).await()
        } catch (t: Throwable) {
            throw SecureResetException("We couldn't reach Tribe Tails. Check your connection and try again.")
        }
        val text = try {
            resp.text().await()
        } catch (t: Throwable) {
            ""
        }
        return secureResetResult(resp.status.toInt(), text)
    }
}
