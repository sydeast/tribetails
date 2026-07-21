package com.tribetails.auntieos.ui.admin.scheduling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Pure-helper tests for the rescheduleBooking time-builder (Stage-1 §A.9 wiring). */
class RescheduleTimesTest {

    @Test
    fun preservesOriginalDurationAndBuildsIso() {
        // Original visit was 60 minutes (14:00-15:00); new start 09:00 -> end 10:00.
        val r = buildRescheduleTimes("2026-05-27", "09:00", "2026-05-27T14:00:00", "2026-05-27T15:00:00")
        assertEquals("2026-05-27T09:00:00" to "2026-05-27T10:00:00", r)
    }

    @Test
    fun defaultsTo30WhenDurationUnparseable() {
        val r = buildRescheduleTimes("2026-05-27", "09:00", "", "")
        assertEquals("2026-05-27T09:00:00" to "2026-05-27T09:30:00", r)
    }

    @Test
    fun rollsOverMidnight() {
        val r = buildRescheduleTimes("2026-05-27", "23:45", "2026-05-27T10:00:00", "2026-05-27T10:30:00")
        assertEquals("2026-05-27T23:45:00" to "2026-05-28T00:15:00", r)
    }

    @Test
    fun nullOnMalformedInput() {
        assertNull(buildRescheduleTimes("bad", "14:00", "", ""))
        assertNull(buildRescheduleTimes("2026-05-27", "9:00", "", "")) // not HH:MM
    }
}
