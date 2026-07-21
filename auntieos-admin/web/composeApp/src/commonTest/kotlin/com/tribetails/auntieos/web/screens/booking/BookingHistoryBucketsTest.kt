package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pure-helper tests for the organized Bookings History (spec 15 item 4):
 * outcome split + most-recent-first sort + timestamp fallback chain.
 */
class BookingHistoryBucketsTest {

    private fun session(
        id: String,
        status: String,
        startTime: String = "",
        completedAt: String = "",
        departedAt: String = "",
        createdAt: String = "",
    ) = KinCareSession(
        _id = id,
        status = status,
        startTime = startTime,
        completedAt = completedAt,
        departedAt = departedAt,
        createdAt = createdAt,
    )

    @Test
    fun splitsByOutcome() {
        val history = listOf(
            session("a", "COMPLETED", startTime = "2026-06-01T09:00:00Z"),
            session("b", "REJECTED", startTime = "2026-06-02T09:00:00Z"),
            session("c", "CANCELLED", startTime = "2026-06-03T09:00:00Z"),
            session("d", "completed", startTime = "2026-05-30T09:00:00Z"),
        )
        val buckets = bookingHistoryBuckets(history)
        assertEquals(listOf("a", "d"), buckets.completed.map { it._id })
        assertEquals(listOf("c", "b"), buckets.cancelled.map { it._id })
        assertEquals(emptyList(), buckets.other.map { it._id })
    }

    @Test
    fun sortsMostRecentFirst() {
        val history = listOf(
            session("old", "COMPLETED", startTime = "2026-01-01T08:00:00Z"),
            session("new", "COMPLETED", startTime = "2026-06-01T08:00:00Z"),
            session("mid", "COMPLETED", startTime = "2026-03-01T08:00:00Z"),
        )
        assertEquals(listOf("new", "mid", "old"), bookingHistoryBuckets(history).completed.map { it._id })
    }

    @Test
    fun uncategorizedStatusGoesToOtherNeverDropped() {
        val history = listOf(session("weird", "SOME_FUTURE_STATUS", startTime = "2026-06-01T08:00:00Z"))
        val buckets = bookingHistoryBuckets(history)
        assertEquals(emptyList(), buckets.completed.map { it._id })
        assertEquals(emptyList(), buckets.cancelled.map { it._id })
        assertEquals(listOf("weird"), buckets.other.map { it._id })
    }

    @Test
    fun sortKeyFallsBackThroughTimestamps() {
        // Legacy import: blank startTime, date lives in completedAt.
        val legacy = session("legacy", "COMPLETED", completedAt = "2026-06-05T10:00:00Z")
        val live = session("live", "COMPLETED", startTime = "2026-06-04T10:00:00Z")
        // legacy (completedAt 06-05) is more recent than live (startTime 06-04).
        assertEquals(listOf("legacy", "live"), bookingHistoryBuckets(listOf(live, legacy)).completed.map { it._id })
    }
}
