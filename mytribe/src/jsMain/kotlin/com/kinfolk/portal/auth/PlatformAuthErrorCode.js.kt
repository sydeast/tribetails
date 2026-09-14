package com.kinfolk.portal.auth

private val JS_AUTH_CODE = Regex("auth/[a-z0-9-]+")

/**
 * gitlive wraps the JS SDK's FirebaseError, whose message carries the code as
 * `Firebase: Error (auth/wrong-password).`. The code can land in the message or
 * only in toString(), so both are searched (same reason as AuthRepository's
 * reCAPTCHA check).
 */
actual fun platformAuthErrorCode(t: Throwable): String? =
    JS_AUTH_CODE.find(t.message.orEmpty())?.value ?: JS_AUTH_CODE.find(t.toString())?.value
