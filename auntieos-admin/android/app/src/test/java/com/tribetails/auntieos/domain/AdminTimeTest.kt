package com.tribetails.auntieos.domain

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

/** #1828: the one admin date and time shape, "Nov 10, 2026 22:32". */
class AdminTimeTest {
    private val chicago = ZoneId.of("America/Chicago")

    @Test
    fun aMomentIsTheMonthAsAWordWithTheYearAndA24HourClock() {
        // 04:32 UTC on Nov 11 is 22:32 on Nov 10 in Chicago.
        assertEquals("Nov 10, 2026 22:32", AdminTime.dateTime(Instant.parse("2026-11-11T04:32:00Z").toEpochMilli(), chicago))
        assertEquals("Jan 5, 2026 00:05", AdminTime.dateTime(Instant.parse("2026-01-05T06:05:00Z").toEpochMilli(), chicago))
    }

    @Test
    fun aDayAndAClockOnTheirOwn() {
        assertEquals("Nov 10, 2026", AdminTime.date(LocalDate.of(2026, 11, 10)))
        assertEquals("22:32", AdminTime.clock(22, 32))
        assertEquals("09:05", AdminTime.clock(9, 5))
    }

    @Test
    fun aDayKeyReadsAsADayAndAnythingElseIsKept() {
        assertEquals("Nov 10, 2026", AdminTime.dayKeyLabel("2026-11-10"))
        assertEquals("Undated", AdminTime.dayKeyLabel("Undated"))
    }

    /** #1828: a late evening visit stays on its business day. */
    @Test
    fun aStoredInstantReadsOnTheBusinessDayNearMidnight() {
        val chicago = java.time.ZoneId.of("America/Chicago")
        assertEquals("Nov 10, 2026 22:30", AdminTime.storedDateTime("2026-11-11T04:30:00Z", chicago))
        assertEquals("Nov 10, 2026 23:59", AdminTime.storedDateTime("2026-11-11T05:59:00.000Z", chicago))
        assertEquals("Nov 11, 2026 00:00", AdminTime.storedDateTime("2026-11-11T06:00:00Z", chicago))
        // A zone-less value already is the business clock.
        assertEquals("Nov 10, 2026 23:30", AdminTime.storedDateTime("2026-11-10T23:30:00", chicago))
        assertEquals(null, AdminTime.storedDateTime("soon", chicago))
        assertEquals("Nov 10, 2026 22:30", com.tribetails.auntieos.ui.inbox.shortDateTime("2026-11-11T04:30:00Z", 2026, chicago))
        assertEquals("Nov 10, 2026 22:30", com.tribetails.auntieos.ui.admin.kinTaleShortDateTime("2026-11-11T04:30:00Z", 2026, chicago))
    }
}
