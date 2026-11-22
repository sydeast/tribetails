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

    /** #1828: a late evening visit stays on its business day. */
    @Test
    fun aStoredInstantReadsOnTheBusinessDayNearMidnight() {
        val chicago = kotlinx.datetime.TimeZone.of("America/Chicago")
        assertEquals("Nov 10, 2026 22:30", AdminTime.storedDateTime("2026-11-11T04:30:00Z", chicago))
        assertEquals("Nov 10, 2026 23:59", AdminTime.storedDateTime("2026-11-11T05:59:00.000Z", chicago))
        assertEquals("Nov 11, 2026 00:00", AdminTime.storedDateTime("2026-11-11T06:00:00Z", chicago))
        assertEquals("Nov 10, 2026 23:30", AdminTime.storedDateTime("2026-11-10T23:30:00", chicago))
        assertEquals("Nov 10, 2026", AdminTime.storedDay("2026-11-11T04:30:00Z", chicago))
        assertEquals(null, AdminTime.storedDateTime("soon", chicago))
        assertEquals("Nov 10, 2026 22:30", com.tribetails.auntieos.web.screens.inbox.shortDateTime("2026-11-11T04:30:00Z", 2026, chicago))
        assertEquals("Nov 10, 2026 22:30", com.tribetails.auntieos.web.screens.kintales.kinTaleShortDateTime("2026-11-11T04:30:00Z", 2026, chicago))
    }
}
