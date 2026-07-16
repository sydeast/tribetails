package com.kinfolk.portal.util

import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CalendarBadgeTest {

    @Test
    fun epoch_formatsMonthAndPaddedDay() {
        // 2024-06-02T00:00:00Z
        val badge = calendarBadge(1_717_286_400_000L, TimeZone.UTC)
        assertEquals(CalendarBadge("JUN", "02"), badge)
    }

    @Test
    fun epoch_doubleDigitDay() {
        // 2023-11-14T22:13:20Z (1_700_000_000_000)
        val badge = calendarBadge(1_700_000_000_000L, TimeZone.UTC)
        assertEquals(CalendarBadge("NOV", "14"), badge)
    }

    @Test
    fun epoch_null_returnsNull() {
        assertNull(calendarBadge(null))
    }

    @Test
    fun label_fullDate_parses() {
        assertEquals(CalendarBadge("SEP", "17"), calendarBadgeFromLabel("Sep 17, 2025"))
    }

    @Test
    fun label_monthDayOnly_padsDay() {
        assertEquals(CalendarBadge("JUN", "07"), calendarBadgeFromLabel("Jun 7"))
    }

    @Test
    fun label_fullMonthName_truncatesToThree() {
        assertEquals(CalendarBadge("AUG", "11"), calendarBadgeFromLabel("August 11, 2025"))
    }

    @Test
    fun label_nullBlankOrUnparseable_returnsNull() {
        assertNull(calendarBadgeFromLabel(null))
        assertNull(calendarBadgeFromLabel("  "))
        assertNull(calendarBadgeFromLabel("—"))
        assertNull(calendarBadgeFromLabel("2025"))
    }
}
