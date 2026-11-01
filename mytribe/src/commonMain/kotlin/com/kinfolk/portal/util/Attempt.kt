package com.kinfolk.portal.util

import kotlin.coroutines.cancellation.CancellationException

/**
 * #1282: `runCatching` for suspend code that must stay cancellable.
 *
 * Screens start their independent reads together (`async { attempt { ... } }`)
 * and apply each answer afterwards, instead of awaiting one callable before
 * asking for the next. Each read keeps its own failure, exactly like the
 * separate try blocks it replaces, and a cancelled screen still cancels:
 * `runCatching` would swallow the [CancellationException].
 */
suspend inline fun <T> attempt(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (c: CancellationException) {
        throw c
    } catch (t: Throwable) {
        Result.failure(t)
    }
