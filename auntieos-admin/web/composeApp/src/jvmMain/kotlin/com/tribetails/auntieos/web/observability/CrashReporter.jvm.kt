package com.tribetails.auntieos.web.observability

import io.sentry.Sentry
import io.sentry.SentryEvent
import io.sentry.SentryLevel

/** DSN: env override (SENTRY_DSN) else the baked public auntieos-admin DSN. */
private val dsn: String =
    System.getenv("SENTRY_DSN")?.takeIf { it.isNotBlank() } ?: AUNTIEOS_SENTRY_DSN

@Volatile private var started = false

actual fun initCrashReporting() {
    if (started || !crashReportingEnabled(dsn)) return
    runCatching {
        Sentry.init { options ->
            options.dsn = dsn
            options.environment = "desktop"
            options.release = "auntieos-desktop"
            options.setTag("client", "auntieos-desktop") // distinguishes desktop in the shared project
            // #1067: a coroutine cancellation is never an error event.
            options.setBeforeSend { event, _ -> filterCancellationEvent(event) }
        }
        // Backstop: route otherwise-silent uncaught exceptions to Sentry, then chain to the
        // prior handler so default crash behavior is preserved.
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            if (!isCancellation(e)) runCatching { Sentry.captureException(e) }
            prev?.uncaughtException(t, e)
        }
        started = true
    }.onFailure { System.err.println("[AuntieOS][sentry] init failed: ${it.message}") }
}

actual fun reportError(throwable: Throwable, context: String?) {
    if (!started || isCancellation(throwable)) return
    if (context != null) Sentry.configureScope { it.setTag("context", context) }
    Sentry.captureException(throwable)
}

actual fun reportMessage(message: String, fatal: Boolean) {
    if (!started) return
    Sentry.captureMessage(message, if (fatal) SentryLevel.FATAL else SentryLevel.INFO)
}

/**
 * #1067: Sentry `beforeSend` guard. Drops (returns null for) an event whose
 * throwable is or chains a coroutine cancellation; keeps every other event.
 */
fun filterCancellationEvent(event: SentryEvent): SentryEvent? =
    if (isCancellation(event.throwable)) null else event
