package com.tribetails.auntieos.web.ui.components

import com.tribetails.auntieos.web.data.FirestoreResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** #2265, #2227: how long a panel's first read may run before it offers Try again. */
const val FIRST_ANSWER_TIMEOUT_MS: Long = 20_000L

/**
 * #2265, #2227: a polled read that has not answered (data or error) within
 * [timeoutMs] ends on [FirestoreResult.Error] with [message], so the panel can
 * show Try again instead of waiting out the HTTP client's 90 s request limit
 * (twice over, for a read made of two requests). Once the first answer is in,
 * every later one passes through unchanged and the stream keeps polling.
 * Cancelling the collector (the sheet closes) cancels the upstream poll.
 */
fun <T> Flow<FirestoreResult<T>>.answersWithin(
    message: String,
    timeoutMs: Long = FIRST_ANSWER_TIMEOUT_MS,
): Flow<FirestoreResult<T>> = channelFlow {
    // Loading first: `collectAsState` keeps the last value when its flow is
    // replaced, so without this a Try again would leave the failure line up
    // until the new read answered.
    send(FirestoreResult.Loading)
    val answered = CompletableDeferred<Unit>()
    val reader = launch {
        this@answersWithin.collect { r ->
            if (r is FirestoreResult.Loading) return@collect
            answered.complete(Unit)
            send(r)
        }
    }
    if (withTimeoutOrNull(timeoutMs) { answered.await() } == null) {
        reader.cancel()
        send(FirestoreResult.Error(message))
    }
}
