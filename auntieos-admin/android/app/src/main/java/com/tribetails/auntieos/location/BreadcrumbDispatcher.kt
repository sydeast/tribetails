package com.tribetails.auntieos.location

import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

/**
 * Single-consumer dispatcher for GPS breadcrumb writes. Buffers (sessionId, point)
 * pairs on a bounded Channel; a drain coroutine on the app-scoped CoroutineScope
 * consumes sequentially and calls `repository.addBreadcrumb`.
 *
 * Properties guaranteed by this layer:
 *   - **Ordering:** single consumer = sequential `repository.addBreadcrumb` calls in
 *     the order points were sent.
 *   - **Cancellation safety:** scoped to app lifecycle (not the foreground service),
 *     so `LocationTrackingService.stopTracking()` no longer kills in-flight writes.
 *   - **Backpressure:** Channel capacity caps memory. Overflow uses DROP_OLDEST -
 *     newer breadcrumbs are more valuable for live tracking than stale ones.
 *
 * Overflow logging is throttled (default 60s window) so a long offline period
 * doesn't spam logcat with one warn per dropped point.
 */
class BreadcrumbDispatcher(
    private val repository: KinCareRepository,
    private val scope: CoroutineScope,
    private val capacity: Int = DEFAULT_CAPACITY,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val overflowLogThrottleMs: Long = DEFAULT_OVERFLOW_LOG_THROTTLE_MS,
) {
    companion object {
        internal const val DEFAULT_CAPACITY = 1024
        internal const val DEFAULT_OVERFLOW_LOG_THROTTLE_MS = 60_000L
    }

    private val channel = Channel<Pair<String, LocationPoint>>(
        capacity = capacity,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    private val droppedCount = AtomicLong(0L)
    private val lastOverflowLogAt = AtomicLong(0L)

    init {
        scope.launch {
            for ((sessionId, point) in channel) {
                runCatching { repository.addBreadcrumb(sessionId, point) }
                    .onFailure { AuntieLog.w("Breadcrumb write failed for session $sessionId", it) }
            }
        }
    }

    /**
     * Non-suspending, fire-and-forget. Returns true if the breadcrumb was enqueued,
     * false if the channel is closed. (Overflow DOES NOT return false - the oldest
     * point is dropped silently and counted; check [snapshotDroppedCount].)
     */
    fun send(sessionId: String, point: LocationPoint): Boolean {
        if (sessionId.isBlank()) return false
        val result = channel.trySend(sessionId to point)
        if (!result.isSuccess) {
            droppedCount.incrementAndGet()
            val prev = lastOverflowLogAt.get()
            val now = nowMs()
            if (shouldLogOverflow(droppedCount.get(), prev, now, overflowLogThrottleMs)) {
                if (lastOverflowLogAt.compareAndSet(prev, now)) {
                    AuntieLog.w("Breadcrumb dispatcher dropped ${droppedCount.get()} points (channel full or closed)")
                }
            }
            return false
        }
        return true
    }

    /** Cumulative count of dropped breadcrumbs since dispatcher init. */
    fun snapshotDroppedCount(): Long = droppedCount.get()

    /** Closes the channel and stops the drain coroutine. App-scope lifetime usually means
     *  this is never called; provided for tests + future graceful-shutdown. */
    fun close() {
        channel.close()
    }
}

/**
 * Pure helper: throttles overflow warn logs. Returns true if `now >= prev + throttleMs`
 * OR if dropped is exactly 1 (always log the first drop). Otherwise false.
 *
 * Edge: a very long offline gap could drop thousands of points before the next
 * window expires - that's intentional. The single log per window names the running
 * total (`droppedCount` snapshot at log time), so the operator sees scale.
 */
internal fun shouldLogOverflow(
    droppedCount: Long,
    prevLoggedAt: Long,
    now: Long,
    throttleMs: Long,
): Boolean {
    if (droppedCount == 1L) return true
    if (throttleMs <= 0L) return true
    return now - prevLoggedAt >= throttleMs
}
