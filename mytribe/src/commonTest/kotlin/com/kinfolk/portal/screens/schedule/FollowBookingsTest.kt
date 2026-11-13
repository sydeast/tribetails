package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.BOOKINGS_POLL_MS
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #2122: the turn behind [KeepBookingsCurrent], at the app's real 30 seconds.
 * The screen tests follow a visit at a short turn because a Compose UI test
 * draws every frame of the time it moves through; this one draws nothing, so
 * it holds the real interval in no time at all.
 */
class FollowBookingsTest {

    @Test
    fun theAppRereadsEveryThirtySeconds() {
        assertEquals(30_000L, BOOKINGS_POLL_MS)
    }

    @Test
    fun whileSomethingIsDue_itRereadsOncePerTurn_andNotBefore() = runTest {
        var reads = 0
        backgroundScope.launch { followBookings(BOOKINGS_POLL_MS, isDue = { true }) { reads++ } }

        advanceTimeBy(BOOKINGS_POLL_MS - 1)
        runCurrent()
        assertEquals(0, reads, "nothing is read before the first turn")

        advanceTimeBy(1)
        runCurrent()
        assertEquals(1, reads)

        advanceTimeBy(BOOKINGS_POLL_MS * 3)
        runCurrent()
        assertEquals(4, reads)
    }

    @Test
    fun onceNothingIsDue_itStopsReading() = runTest {
        var reads = 0
        var due = true
        backgroundScope.launch {
            followBookings(BOOKINGS_POLL_MS, isDue = { due }) {
                reads++
                // The read that brings the visit to Completed.
                if (reads == 2) due = false
            }
        }

        advanceTimeBy(BOOKINGS_POLL_MS * 2)
        runCurrent()
        assertEquals(2, reads)

        advanceTimeBy(BOOKINGS_POLL_MS * 10)
        runCurrent()
        assertEquals(2, reads, "a finished visit costs no more reads")
    }

    @Test
    fun aReadThatComesDueLater_isPickedUpOnTheNextTurn() = runTest {
        var reads = 0
        var due = false
        backgroundScope.launch { followBookings(BOOKINGS_POLL_MS, isDue = { due }) { reads++ } }

        advanceTimeBy(BOOKINGS_POLL_MS * 2 + 1)
        runCurrent()
        assertEquals(0, reads, "nothing due, nothing read")

        due = true
        advanceTimeBy(BOOKINGS_POLL_MS)
        runCurrent()
        assertEquals(1, reads)
    }
}
