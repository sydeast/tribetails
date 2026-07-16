package com.kinfolk.portal.auth

import com.kinfolk.portal.auth.recaptcha.getAuth
import com.kinfolk.portal.auth.recaptcha.initializeRecaptchaConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/** Settled (success OR failure) once `initializeRecaptchaConfig` resolves. */
private val recaptchaReady = CompletableDeferred<Unit>()

/** True after [initRecaptchaForMyTribe] has been called. Guards the await so
 *  a build that never wires the bootstrap can't stall sign-in on the timeout. */
private var recaptchaInitStarted = false

/**
 * Wires Identity Platform reCAPTCHA Enterprise auto-attach onto Firebase Auth.
 *
 * Why: Identity Toolkit rejects sign-in with HTTP 503 "Error code: 47" when the
 * project has a Web platform site key configured (Firebase Console → Auth →
 * Settings → reCAPTCHA) and no reCAPTCHA token rides along on the request.
 * `initializeRecaptchaConfig` installs an interceptor on the Auth instance that
 * fetches a token from the configured Web site key and attaches it to every
 * sign-in / sign-up / password-reset call.
 *
 * Must be called AFTER `Firebase.initialize(...)` so the default app exists.
 * Calls `getAuth()` from firebase/auth directly — webpack resolves the SAME
 * 10.14 module instance gitlive uses, so the interceptor binds to the auth
 * gitlive will then operate on.
 *
 * Failure is logged but not thrown — falls back to no-token attach. Either
 * outcome settles [recaptchaReady] so [awaitRecaptchaReady] never waits on a
 * lost cause; the sign-in retry layer (AuthRepository) covers the rest.
 */
fun initRecaptchaForMyTribe() {
    recaptchaInitStarted = true
    val auth = getAuth()
    initializeRecaptchaConfig(auth)
        .then(
            onFulfilled = {
                console.log("[Auth] reCAPTCHA Enterprise initialized")
                recaptchaReady.complete(Unit)
                Unit
            },
            onRejected = { e ->
                console.warn("[Auth] initializeRecaptchaConfig failed:", e)
                recaptchaReady.complete(Unit)
                Unit
            },
        )
}

/**
 * Suspends until the interceptor init settles or [timeoutMs] elapses. No-op
 * when [initRecaptchaForMyTribe] was never called (nothing to wait for).
 */
actual suspend fun awaitRecaptchaReady(timeoutMs: Long) {
    if (!recaptchaInitStarted) return
    withTimeoutOrNull(timeoutMs) { recaptchaReady.await() }
}
