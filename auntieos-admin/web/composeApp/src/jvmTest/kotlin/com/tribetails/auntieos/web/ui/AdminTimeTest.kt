package com.tribetails.auntieos.web.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.datetime.LocalDateTime

/** #1828: the one admin date and time shape, "Nov 10, 2026 22:32". */
class AdminTimeTest {
    @Test
    fun aMomentIsTheMonthAsAWordWithTheYearAndA24HourClock() {
        assertEquals("Nov 10, 2026 22:32", AdminTime.dateTime(LocalDateTime(2026, 11, 10, 22, 32)))
        assertEquals("Jan 5, 2026 00:05", AdminTime.dateTime(2026, 1, 5, 0, 5))
    }

    @Test
    fun aStoredWallClockStringReadsPositionally() {
        assertEquals("Nov 10, 2026 22:32", AdminTime.dateTimeOfWallClock("2026-11-10T22:32:00"))
        assertEquals("Nov 10, 2026 22:32", AdminTime.dateTimeOfWallClock("2026-11-10 22:32"))
        assertNull(AdminTime.dateTimeOfWallClock("Nov 10"))
    }

    @Test
    fun aDayKeyReadsAsADayAndAnythingElseIsKept() {
        assertEquals("Nov 10, 2026", AdminTime.dayKeyLabel("2026-11-10"))
        assertEquals("Undated", AdminTime.dayKeyLabel("Undated"))
        assertEquals("09:00", AdminTime.clock(9, 0))
    }
}
