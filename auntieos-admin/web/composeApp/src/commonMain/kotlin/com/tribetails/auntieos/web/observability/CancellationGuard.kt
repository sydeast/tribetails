package com.tribetails.auntieos.web.observability
import kotlin.coroutines.cancellation.CancellationException
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
