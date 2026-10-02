package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.data.BookingTimeSlot
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure-helper tests for the Schedule "Busy" block pipeline: the BLOCKED-slot
 * filter/group ([blockedSlotsByDate]) and the week-grid placement ([busyPlacement]).
 * Mirrors Android's `timeSlots.filter { !it.isAvailable }` render of Google-busy
 * imports written to booking_time_slots by syncGoogleCalendarBusyEvents.
 */
class BusySlotsTest {

    private fun slot(
        id: String,
        date: String,
        start: String = "10:00",
        end: String = "11:00",
        available: Boolean = false,
        source: String = "GOOGLE_BUSY_IMPORT",
    ) = BookingTimeSlot(
        _id = id,
        date = date,
        startTime = start,
        endTime = end,
        isAvailable = available,
        slotType = if (available) "AVAILABLE" else "BLOCKED",
        source = source,
    )

    @Test
    fun keepsOnlyBlockedSlots() {
        val grouped = blockedSlotsByDate(
            listOf(
                slot("a", "2026-06-05", available = false),
                slot("b", "2026-06-05", available = true), // available -> dropped
                slot("c", "2026-06-06", available = false),
            )
        )
        assertEquals(setOf("2026-06-05", "2026-06-06"), grouped.keys)
        assertEquals(listOf("a"), grouped["2026-06-05"]!!.map { it._id })
        assertEquals(listOf("c"), grouped["2026-06-06"]!!.map { it._id })
    }

    @Test
    fun dropsBlankDateSlots() {
        val grouped = blockedSlotsByDate(listOf(slot("a", "", available = false)))
        assertTrue(grouped.isEmpty())
    }

    @Test
    fun sortsBlocksByStartTimeWithinDay() {
        val grouped = blockedSlotsByDate(
            listOf(
                slot("late", "2026-06-05", start = "15:00"),
                slot("early", "2026-06-05", start = "09:00"),
                slot("mid", "2026-06-05", start = "12:00"),
            )
        )
        assertEquals(listOf("early", "mid", "late"), grouped["2026-06-05"]!!.map { it._id })
    }

    @Test
    fun placesInWindowBlock() {
        // 9a start in the 8a..6p window -> top 60 min from window start.
        val p = busyPlacement("09:00", "10:30")
        assertNotNull(p)
        assertEquals(60, p.topMinutes)
        assertEquals(90, p.heightMinutes)
    }

    @Test
    fun offWindowSlotsDropOut() {
        assertNull(busyPlacement("06:00", "07:00")) // before window
        assertNull(busyPlacement("18:00", "19:00")) // at/after window end
        assertNull(busyPlacement("20:00", "21:00")) // after window
    }

    @Test
    fun blockStartingBeforeTheWindowIsClampedToItsTop() {
        // 07:00 to 10:00 draws 08:00 to 10:00: top of the grid, two hours tall.
        val p = busyPlacement("07:00", "10:00")
        assertNotNull(p)
        assertEquals(0, p!!.topMinutes)
        assertEquals(120, p.heightMinutes)
    }
    @Test
    fun blockEndingAfterTheWindowIsClampedToItsBottom() {
        // 17:00 to 20:00 draws 17:00 to 18:00.
        val p = busyPlacement("17:00", "20:00")
        assertNotNull(p)
        assertEquals(540, p!!.topMinutes)
        assertEquals(60, p.heightMinutes)
    }
    @Test
    fun blockEndingExactlyAtTheWindowTopStaysOut() {
        assertNull(busyPlacement("07:00", "08:00"))
    }
    @Test
    fun unparseableTimesDropOut() {
        assertNull(busyPlacement("", ""))
        assertNull(busyPlacement("nope", "nope"))
        assertNull(busyPlacement("25:00", "26:00")) // out-of-range hour
    }

    @Test
    fun missingEndGetsMinVisibleHeight() {
        val p = busyPlacement("10:00", "")
        assertNotNull(p)
        assertEquals(120, p.topMinutes)
        assertEquals(20, p.heightMinutes) // min visible band
    }

    @Test
    fun heightClampedToWindowBottom() {
        // Starts 10 min before the 6p bottom; height can't overrun it.
        val p = busyPlacement("17:50", "19:00")
        assertNotNull(p)
        assertTrue(p.heightMinutes <= 10, "expected <=10 got ${p.heightMinutes}")
    }

    @Test
    fun clampedBlockLabelKeepsTheRealTimes() {
        assertEquals("07:00 to 10:00", busyRangeLabel("07:00", "10:00"))
        assertEquals("17:00 to 20:00", busyRangeLabel("17:00", "20:00"))
        assertEquals("09:00", busyRangeLabel("09:00", ""))
        assertEquals("", busyRangeLabel("", ""))
    }
}
