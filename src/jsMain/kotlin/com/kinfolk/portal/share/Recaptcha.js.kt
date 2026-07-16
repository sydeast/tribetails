package com.kinfolk.portal.share

import kotlinx.browser.window
import kotlinx.coroutines.await
import kotlinx.coroutines.delay
import kotlin.js.Promise
import kotlin.js.json

/**
 * Calls window.grecaptcha.enterprise.execute(siteKey, {action}). Waits up to
 * 5s for the script to attach grecaptcha — async defer means it may not be
 * ready the instant Compose mounts. After timeout, throws so the form can
 * render a fail-loud banner.
 */
actual suspend fun executeRecaptcha(action: String): String? {
    val grecaptcha = waitForGrecaptcha()
        ?: throw RecaptchaUnavailableException(
            "reCAPTCHA Enterprise script never loaded. Check network + script-src CSP.",
        )
    val promise = grecaptcha.enterprise!!.execute(
        RECAPTCHA_SITE_KEY,
        json("action" to action),
    )
    return promise.await()
}

private suspend fun waitForGrecaptcha(): GrecaptchaEnterprise? {
    repeat(50) {
        val g = jsGrecaptcha()
        if (g != null && g.enterprise != null) {
            // grecaptcha.enterprise.ready callback fires once the runtime is
            // safe to call execute() against.
            var ready = false
            g.enterprise!!.ready { ready = true }
            // Yield until ready flips true. Cap at 1s.
            repeat(20) {
                if (ready) return g
                delay(50)
            }
            return g
        }
        delay(100)
    }
    return null
}

private fun jsGrecaptcha(): GrecaptchaEnterprise? {
    val raw = window.asDynamic().grecaptcha
    return if (raw == undefined) null else raw.unsafeCast<GrecaptchaEnterprise>()
}


// ---- External JS interface shape ----

private external interface GrecaptchaEnterprise {
    val enterprise: GrecaptchaEnterpriseApi?
}

private external interface GrecaptchaEnterpriseApi {
    fun ready(cb: () -> Unit)
    fun execute(siteKey: String, opts: dynamic): Promise<String>
}
