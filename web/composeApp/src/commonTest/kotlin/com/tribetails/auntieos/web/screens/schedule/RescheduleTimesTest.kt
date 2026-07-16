package com.tribetails.auntieos.web.screens.schedule

import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Pure-helper tests for the rescheduleBooking time-builder (Stage-1 §A.9 wiring). */
class RescheduleTimesTest {

    @Test
    fun splitsIsoForPrefill() {
        assertEquals("2026-05-27", isoDatePart("2026-05-27T14:00:00Z"))
        assertEquals("14:00", isoTimePart("2026-05-27T14:00:00Z"))
        assertEquals("", isoTimePart("2026-05-27")) // no time part
    }

    @Test
    fun buildsStartAndDurationDerivedEnd() {
        val r = buildRescheduleTimes("2026-05-27", "14:00", 30, TimeZone.UTC)
        assertEquals("2026-05-27T14:00:00" to "2026-05-27T14:30:00", r)
    }

    @Test
    fun defaultsDurationWhenMissing() {
        val r = buildRescheduleTimes("2026-05-27", "09:00", 0, TimeZone.UTC)
        assertEquals("2026-05-27T09:00:00" to "2026-05-27T09:30:00", r)
    }

    @Test
    fun rollsOverMidnight() {
        val r = buildRescheduleTimes("2026-05-27", "23:45", 30, TimeZone.UTC)
        assertEquals("2026-05-27T23:45:00" to "2026-05-28T00:15:00", r)
    }

    @Test
    fun nullOnMalformedInput() {
        assertNull(buildRescheduleTimes("bad", "14:00", 30, TimeZone.UTC))
        assertNull(buildRescheduleTimes("2026-05-27", "9:00", 30, TimeZone.UTC)) // not HH:MM
    }
}
