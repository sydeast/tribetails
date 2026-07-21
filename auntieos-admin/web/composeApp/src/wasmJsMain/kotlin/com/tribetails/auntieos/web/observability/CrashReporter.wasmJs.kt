package com.tribetails.auntieos.web.observability

// Web crash/error reporting (0H). Bridges to window.__sentry, defined in the self-hosted
// sentry-bridge.js (loaded from index.html), which POSTs Sentry envelopes to the shared
// auntieos-admin project and auto-hooks window.onerror / unhandledrejection. Self-hosted (no
// CDN SDK) so the CSP only needs the ingest host added to connect-src, no script-src change.

@JsFun("() => { try { return (window.__sentry && window.__sentry.init) ? (window.__sentry.init(), true) : false } catch (e) { return false } }")
private external fun jsSentryInit(): Boolean

@JsFun("(message, fatal) => { try { if (window.__sentry && window.__sentry.captureMessage) window.__sentry.captureMessage(message, fatal) } catch (e) {} }")
private external fun jsSentryCapture(message: String, fatal: Boolean)

actual fun initCrashReporting() {
    jsSentryInit()
}

actual fun reportError(throwable: Throwable, context: String?) {
    val sb = StringBuilder()
    if (context != null) { sb.append(context); sb.append(": ") }
    sb.append(throwable.message ?: throwable::class.simpleName ?: "error")
    sb.append('\n').append(throwable.stackTraceToString())
    jsSentryCapture(sb.toString(), true)
}

actual fun reportMessage(message: String, fatal: Boolean) {
    jsSentryCapture(message, fatal)
}
