package com.tribetails.auntieos.util

import io.sentry.SentryEvent
import kotlinx.coroutines.TimeoutCancellationException
import kotlin.coroutines.cancellation.CancellationException

/**
 * True when [error] is coroutine cancellation, directly or anywhere in its
 * cause chain.
 *
 * #1067 / AUNTIEOS-ADMIN-1X / AUNTIEOS-ADMIN-1Z: Compose cancels the coroutine
 * behind a `LaunchedEffect` or a `rememberCoroutineScope` when that call leaves
 * the composition, with `LeftCompositionCancellationException` and
 * `ForgottenCoroutineScopeException` respectively. Both are ordinary
 * [CancellationException]s: the coroutine was told to stop, nothing failed. The
 * repository's `runCatching { ... }.onFailure { AuntieLog.e(...) }` shape
 * catches them like any other throwable, so every sign-in redirect and every
 * screen change that interrupted a read reported a "bug" to Sentry. Cancellation
 * is the one thing that must never be reported as an error, so [AuntieLog] and
 * the Sentry `beforeSend` hook ([dropCancellationEvent]) both check this.
 *
 * [TimeoutCancellationException] is NOT treated as cancellation here, even
 * though it extends [CancellationException]: a `withTimeout` that expired is a
 * real failure the caller asked to hear about, not a teardown.
 *
 * Walks at most [MAX_CAUSE_DEPTH] links, which also bounds a cyclic chain (a
 * throwable whose cause points back at itself would otherwise spin forever).
 */
fun isCoroutineCancellation(error: Throwable?): Boolean {
    var current = error
    var depth = 0
    while (current != null && depth < MAX_CAUSE_DEPTH) {
        if (current is TimeoutCancellationException) return false
        if (current is CancellationException) return true
        // Guarded and bounded because this runs inside AuntieLog for EVERY
        // reported throwable, and a logger must never throw or spin: a strict
        // test double has no `cause` to hand back, and a relaxed one hands back
        // a fresh double every time, so the chain never ends or repeats.
        current = runCatching { current?.cause }.getOrNull()
        depth++
    }
    return false
}

private const val MAX_CAUSE_DEPTH = 8

/**
 * Sentry `beforeSend` filter: returns null (drop) for an event carrying a
 * coroutine cancellation, otherwise the event unchanged.
 *
 * Second line behind [AuntieLog]: a direct `Sentry.captureException` anywhere in
 * the app, or in a library, still lands here. Checks the in-process throwable
 * first, then the serialized exception types, because a chained event can reach
 * `beforeSend` with only the `exceptions` list populated.
 */
fun dropCancellationEvent(event: SentryEvent): SentryEvent? {
    if (isCoroutineCancellation(event.throwable)) return null
    val cancelledByType = event.exceptions.orEmpty().any { ex ->
        val type = ex.type ?: return@any false
        type != "TimeoutCancellationException" &&
            (type.endsWith("CancellationException") || type == "ForgottenCoroutineScopeException")
    }
    return if (cancelledByType) null else event
}

/**
 * Rethrows when this [Result] failed because the calling coroutine was
 * cancelled, so a composable or ViewModel that folds a repository `Result` into
 * error UI does not render (or report) its own cancellation as a failure.
 * The repository's `runCatching` swallows the [CancellationException]; this
 * puts it back where structured concurrency expects it.
 */
fun <T> Result<T>.rethrowCancellation(): Result<T> {
    val error = exceptionOrNull()
    if (error != null && isCoroutineCancellation(error)) {
        throw (error as? CancellationException)
            ?: CancellationException("Coroutine cancelled", error)
    }
    return this
}
