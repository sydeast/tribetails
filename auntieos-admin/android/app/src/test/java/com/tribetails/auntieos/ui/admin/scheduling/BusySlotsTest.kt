package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.TimeSlotSource
import com.tribetails.auntieos.data.model.TimeSlotType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for the Schedule "Busy" band pipeline: the BLOCKED-slot
 * filter/group ([blockedSlotsByDate]) and the grid placement ([busyPlacement]).
 * Mirrors the web BusySlotsTest byte-for-byte: these are the Google-busy imports
 * written to booking_time_slots by syncGoogleCalendarBusyEvents, rendered as
 * read-only bands (`timeSlots.filter { !it.isAvailable }`).
 */
class BusySlotsTest {

    private fun slot(
        id: String,
        date: String,
        start: String = "10:00",
        end: String = "11:00",
        available: Boolean = false,
    ) = BookingTimeSlot(
        id = id,
        date = date,
        startTime = start,
        endTime = end,
        isAvailable = available,
        slotType = if (available) TimeSlotType.AVAILABLE else TimeSlotType.BLOCKED,
        source = TimeSlotSource.GOOGLE_BUSY_IMPORT,
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
        assertEquals(listOf("a"), grouped["2026-06-05"]!!.map { it.id })
        assertEquals(listOf("c"), grouped["2026-06-06"]!!.map { it.id })
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
        assertEquals(listOf("early", "mid", "late"), grouped["2026-06-05"]!!.map { it.id })
    }

    @Test
    fun placesInWindowBlock() {
        // 9a start in the 8a..6p window -> top 60 min from window start.
        val p = busyPlacement("09:00", "10:30")
        assertNotNull(p)
        assertEquals(60, p!!.topMinutes)
        assertEquals(90, p.heightMinutes)
    }

    @Test
    fun offWindowSlotsDropOut() {
        assertNull(busyPlacement("06:00", "07:00")) // before window
        assertNull(busyPlacement("18:00", "19:00")) // at/after window end
        assertNull(busyPlacement("20:00", "21:00")) // after window
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
        assertEquals(120, p!!.topMinutes)
        assertEquals(20, p.heightMinutes) // min visible band
    }

    @Test
    fun heightClampedToWindowBottom() {
        // Starts 10 min before the 6p bottom; height can't overrun it.
        val p = busyPlacement("17:50", "19:00")
        assertNotNull(p)
        assertTrue("expected <=10 got ${p!!.heightMinutes}", p.heightMinutes <= 10)
    }
}
