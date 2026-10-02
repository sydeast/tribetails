package com.kinfolk.portal.error

import kotlin.coroutines.cancellation.CancellationException

/**
 * #1067 (seen on the admin as AUNTIEOS-ADMIN-1X / 1Z): true when [error] is a
 * coroutine [CancellationException] or carries one anywhere in its cause chain.
 * Compose cancels a `LaunchedEffect`/`rememberCoroutineScope` scope the moment
 * it leaves composition (LeftCompositionCancellationException,
 * ForgottenCoroutineScopeException, both CancellationException subclasses): a
 * scope being torn down, never an error. The portal's Sentry `beforeSend` uses
 * this to drop such events. Bounded so a looping cause chain cannot hang, and a
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
/**
 * #1079: first line of a catch-all on a coroutine path. Lets a cancellation keep
 * propagating so the coroutine actually stops instead of running on to its next
 * suspension point and setting error state. Checks only this throwable, not its
 * causes: a wrapper whose cause is a cancellation is a real failure.
 */
fun Throwable.rethrowIfCancellation() {
    if (this is CancellationException) throw this
}
/**
 * [runCatching] for coroutine paths: captures failures as a [Result] but
 * rethrows cancellation. Inline so a suspending [block] is allowed.
 */
inline fun <T> runCatchingCancellable(block: () -> T): Result<T> =
    runCatching(block).onFailure { it.rethrowIfCancellation() }
