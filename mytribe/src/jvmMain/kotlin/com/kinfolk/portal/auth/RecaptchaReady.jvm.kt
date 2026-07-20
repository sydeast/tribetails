package com.kinfolk.portal.auth

/** Desktop signs in over the Firebase REST API — no reCAPTCHA interceptor to wait for. */
actual suspend fun awaitRecaptchaReady(timeoutMs: Long) = Unit
