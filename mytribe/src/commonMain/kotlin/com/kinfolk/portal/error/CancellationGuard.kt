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
