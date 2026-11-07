package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/** #1599: a KinTale row from another year says which year. */
class KinTaleShortDateTimeTest {
    @Test
    fun thisYearIsMonthDayAndTime() {
        assertEquals("Nov 5 · 14:02", kinTaleShortDateTime("2026-11-05T14:02:00Z", 2026))
    }

    @Test
    fun anotherYearCarriesTheYear() {
        assertEquals("Sep 3, 2025 · 14:02", kinTaleShortDateTime("2025-09-03T14:02:00Z", 2026))
    }

    @Test
    fun freeTextIsEchoed() {
        assertEquals("Sep 3", kinTaleShortDateTime("Sep 3", 2026))
    }
}
