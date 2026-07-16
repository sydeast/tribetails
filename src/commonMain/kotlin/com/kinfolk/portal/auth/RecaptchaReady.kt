package com.kinfolk.portal.auth

/**
 * Upper bound on how long a sign-in attempt waits for the web reCAPTCHA
 * interceptor to finish initializing. Generous enough for a cold
 * `initializeRecaptchaConfig` round-trip, small enough that a hung init can
 * never wedge the sign-in button forever.
 */
const val RECAPTCHA_READY_TIMEOUT_MS: Long = 8_000

/**
 * Suspends until the platform's reCAPTCHA sign-in interceptor is ready, the
 * init has failed (waiting longer cannot help), or [timeoutMs] elapses —
 * whichever comes first. Never throws and never hangs.
 *
 * Only web has anything to wait for: `initializeRecaptchaConfig` (see jsMain
 * RecaptchaBootstrap.kt) races the first sign-in, and a token-less request is
 * rejected by Identity Toolkit with HTTP 503 "Error code: 47". jvm signs in
 * over the Firebase REST API and android uses the native SDK — both actuals
 * are no-ops.
 */
expect suspend fun awaitRecaptchaReady(timeoutMs: Long = RECAPTCHA_READY_TIMEOUT_MS)

/**
 * True when a sign-in rejection looks like Identity Toolkit's
 * "reCAPTCHA token missing" failure. Observed shapes:
 *  - raw REST rejection: HTTP 503 carrying "Error code: 47"
 *  - firebase-js-sdk wrapping: FirebaseError code "auth/internal-error"
 *    (verified live 2026-07-09: the SDK swallows the 503 body and the only
 *    surviving signal is the internal-error code). Wrong-password rejections
 *    arrive as auth/invalid-credential, so a single transparent retry on
 *    internal-error is safe and idempotent.
 * Pure string check so the retry decision is unit-testable everywhere.
 */
fun isRecaptchaMissingError(message: String?): Boolean =
    message != null &&
        ("Error code: 47" in message ||
            "503" in message ||
            "internal-error" in message ||
            "INTERNAL ASSERTION" in message)
