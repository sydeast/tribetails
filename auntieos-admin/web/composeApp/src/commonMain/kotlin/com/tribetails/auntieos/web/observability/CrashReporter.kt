package com.tribetails.auntieos.web.observability

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlin.coroutines.cancellation.CancellationException

/**
 * Cross-platform crash/error reporting seam (0H). Android has its own Sentry setup; this
 * brings coverage to the web/ project's remaining target:
 *   - desktop (JVM): the official io.sentry:sentry SDK (see CrashReporter.jvm.kt)
 *
 * There was a wasm actual too, a self-hosted sentry-bridge.js posting Sentry
 * envelopes; it went with the wasm admin in #481.
 *
 * Reports go to the shared `auntieos-admin` Sentry project (reused per the 0H decision),
 * distinguished by the `platform` tag the actual sets. The DSN is a public client key (it
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

/**
 * The sink [reportingExceptionHandler] routes to. Defaults to [reportError].
 * Overridable only so commonTest can observe what would be reported without a
 * live Sentry transport; production never reassigns it.
 */
internal var errorSink: (Throwable, String?) -> Unit = ::reportError

/**
 * A [CoroutineExceptionHandler] that routes any UNCAUGHT coroutine failure to
 * [reportError] while the throwable is still a typed Kotlin [Throwable] (AO-9).
 *
 * Why this exists: on Kotlin/Wasm an exception that escapes an unhandled
 * coroutine reaches `window.onerror`, where it stringifies to the literal
 * `[object WebAssembly.Exception]` — type, message and stack all lost. Catching
 * it at the coroutine boundary, in Kotlin, preserves all three. [reportError]
 * already unwraps `message` + `stackTraceToString()`; it just was never called.
 */
fun reportingExceptionHandler(context: String? = null): CoroutineExceptionHandler =
    CoroutineExceptionHandler { _, throwable ->
        if (!isCancellation(throwable)) errorSink(throwable, context)
    }

/**
 * Drop-in replacement for `rememberCoroutineScope()` that additionally reports
 * uncaught failures of coroutines launched on the returned scope (AO-9). Prefer
 * this over `rememberCoroutineScope()` for any scope that `launch {}`es work
 * which can throw — which, on the admin surface, is effectively all of them.
 */
@Composable
fun rememberReportingScope(context: String? = null): CoroutineScope {
    val handler = remember(context) { reportingExceptionHandler(context) }
    return rememberCoroutineScope { handler }
}

/**
 * #1067 (AUNTIEOS-ADMIN-1X, AUNTIEOS-ADMIN-1Z): true when [error] is a coroutine
 * [CancellationException] or carries one anywhere in its cause chain. Compose
 * cancels a `LaunchedEffect`/`rememberCoroutineScope` scope the moment it leaves
 * composition (LeftCompositionCancellationException, ForgottenCoroutineScopeException,
 * both CancellationException subclasses): a scope being torn down, never an error,
 * so nothing here reports one. Bounded so a looping cause chain cannot hang, and a
 * `cause` getter that throws ends the walk instead of escaping the reporter.
 */
fun isCancellation(error: Throwable?): Boolean {
    var current = error
    var depth = 0
    while (current != null && depth < MAX_CAUSE_DEPTH) {
        if (current is CancellationException) return true
        val next = try {
            current.cause
        } catch (_: Exception) {
            return false
        }
        if (next === current) return false
        current = next
        depth++
    }
    return false
}

private const val MAX_CAUSE_DEPTH = 16
