package com.tribetails.auntieos.web.observability

/**
 * Cross-platform crash/error reporting seam (0H). Android has its own Sentry setup; this
 * brings coverage to the web/ project's two targets:
 *   - desktop (JVM): the official io.sentry:sentry SDK (see CrashReporter.jvm.kt)
 *   - web (Wasm): a self-hosted sentry-bridge.js that POSTs Sentry envelopes (CrashReporter.wasmJs.kt)
 *
 * Both report to the shared `auntieos-admin` Sentry project (reused per the 0H decision),
 * distinguished by the `platform` tag the actuals set. The DSN is a public client key (it
 * already ships in the Android APK and the browser bridge), so embedding it is safe.
 */
const val AUNTIEOS_SENTRY_DSN =
    "https://b219cf4fe0ad95909c3ded27776055aa@o4511074771533824.ingest.us.sentry.io/4511282806521856"

/** True when a usable Sentry DSN is configured. Pure + testable; gates init fail-loud-safely. */
fun crashReportingEnabled(dsn: String?): Boolean = !dsn.isNullOrBlank()

/** Initialize crash/error reporting for this platform. No-op when no DSN is configured. */
expect fun initCrashReporting()

/** Report a caught throwable, with an optional context label for triage. */
expect fun reportError(throwable: Throwable, context: String? = null)

/** Report a message; [fatal] marks crash-class events. */
expect fun reportMessage(message: String, fatal: Boolean = false)
