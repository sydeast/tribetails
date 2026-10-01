package com.tribetails.auntieos.util

import io.sentry.SentryEvent
import kotlinx.coroutines.CancellationException

/**
 * #1067 (AUNTIEOS-ADMIN-1X, AUNTIEOS-ADMIN-1Z): coroutine cancellation is a
 * coroutine being told to stop, never a defect. Compose cancels a
 * `LaunchedEffect` or `rememberCoroutineScope` scope the moment it leaves
 * composition (navigating away mid-load), throwing
 * `LeftCompositionCancellationException` or `ForgottenCoroutineScopeException`
 * into whatever was suspended. Both extend [CancellationException], as does
 * `TimeoutCancellationException`. A catch-all that swallows one reports a
 * phantom error and breaks cooperative cancellation.
 *
 * True when [error] is a [CancellationException] or carries one anywhere in its
 * cause chain. The walk is bounded so a cause chain that loops cannot hang the
 * reporter, and a `cause` getter that throws (a subclass overriding it, or a
 * strict test double) ends the walk instead of throwing out of a catch block.
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

/**
 * Sentry `beforeSend` guard: drops (returns null for) an event whose throwable
 * is or chains a cancellation, keeps every other event untouched. This is the
 * backstop for any path that reaches `Sentry.captureException` without going
 * through [AuntieLog].
 */
fun filterCancellationEvent(event: SentryEvent): SentryEvent? =
    if (isCancellation(event.throwable)) null else event

/**
 * First line of a catch-all on a coroutine path: lets a cancellation keep
 * propagating so the coroutine actually stops. Checks only this throwable, not
 * its causes: a wrapper whose cause is a cancellation is not itself a
 * cancellation signal, and rethrowing it would surface a real-looking error.
 */
fun Throwable.rethrowIfCancellation() {
    if (this is CancellationException) throw this
}

/**
 * [runCatching] for coroutine paths: captures failures as a [Result] but
 * rethrows cancellation. Inline so a suspending [block] is allowed, the same as
 * [runCatching].
 */
inline fun <T> runCatchingCancellable(block: () -> T): Result<T> =
    runCatching(block).onFailure { it.rethrowIfCancellation() }
