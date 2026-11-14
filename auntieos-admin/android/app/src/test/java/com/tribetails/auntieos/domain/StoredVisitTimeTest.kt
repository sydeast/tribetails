package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

/** #2095: a stored visit time reads on the business clock, never as its UTC characters. */
class StoredVisitTimeTest {
    private val chicago = ZoneId.of("America/Chicago")

    @Test
    fun `an 11 30 PM Chicago visit stored as a UTC instant reads Nov 11 23 30`() {
        assertEquals("2026-11-11", storedBusinessDay("2026-11-12T05:30:00Z", chicago))
        assertEquals("23:30", storedBusinessClock("2026-11-12T05:30:00Z", chicago))
        assertEquals("23:30", storedBusinessClock("2026-11-12T05:30:00.000Z", chicago))
    }

    @Test
    fun `a zone-less wall clock is kept as it is`() {
        assertEquals("2026-11-11", storedBusinessDay("2026-11-11T23:30:00", chicago))
        assertEquals("23:30", storedBusinessClock("2026-11-11T23:30", chicago))
    }

    @Test
    fun `an offset is read as the instant it names`() {
        assertEquals("23:30", storedBusinessClock("2026-11-12T00:30:00-05:00", chicago))
    }

    @Test
    fun `the night clocks go back, Nov 1 2026`() {
        assertEquals("2026-10-31", storedBusinessDay("2026-11-01T04:30:00Z", chicago))
        assertEquals("23:30", storedBusinessClock("2026-11-01T04:30:00Z", chicago))
        assertEquals("2026-11-01", storedBusinessDay("2026-11-02T05:30:00Z", chicago))
        assertEquals("23:30", storedBusinessClock("2026-11-02T05:30:00Z", chicago))
    }

    @Test
    fun `the night clocks go forward, Mar 8 2026`() {
        assertEquals("2026-03-07", storedBusinessDay("2026-03-08T05:30:00Z", chicago))
        assertEquals("2026-03-08", storedBusinessDay("2026-03-08T06:30:00Z", chicago))
        assertEquals("00:30", storedBusinessClock("2026-03-08T06:30:00Z", chicago))
    }

    @Test
    fun `a date alone keeps its date, and nothing readable gives blanks`() {
        assertEquals("2026-11-11", storedBusinessDay("2026-11-11", chicago))
        assertEquals("", storedBusinessClock("2026-11-11", chicago))
        assertEquals("", storedBusinessDay("", chicago))
        assertEquals("", storedBusinessDay(null, chicago))
        assertNull(storedBusinessLocal("soon", chicago))
    }
}
