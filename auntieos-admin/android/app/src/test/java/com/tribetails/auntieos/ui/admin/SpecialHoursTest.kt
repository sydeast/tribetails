package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure-helper tests for the special-hours add row (spec 29 item 15.5), now on
 * the server's rules and sentences (#1593): a real date that has not passed,
 * and `HH:MM-HH:MM` hours closing after opening.
 */
class SpecialHoursTest {

    private val today = "2026-11-09"

    @Test
    fun aRealFutureDateAndHoursAdd() {
        assertFalse(specialHoursAddProblems("2026-12-24", "08:00-12:00", today).any)
        assertFalse(specialHoursAddProblems(today, "8:00-12:00", today).any)
    }

    @Test
    fun aDateThatIsNotRealIsRefused() {
        assertEquals(DATE_INVALID, specialHoursAddProblems("2026-13-45", "08:00-12:00", today).date)
        assertEquals(DATE_INVALID, specialHoursAddProblems("2027-02-30", "08:00-12:00", today).date)
        assertEquals(DATE_INVALID, specialHoursAddProblems("12/24/26", "08:00-12:00", today).date)
        assertEquals(DATE_INVALID, specialHoursAddProblems("", "08:00-12:00", today).date)
    }

    @Test
    fun aPastDateIsRefused() {
        assertEquals(DATE_PAST, specialHoursAddProblems("2026-11-08", "08:00-12:00", today).date)
    }

    @Test
    fun hoursThatDoNotReadAreRefused() {
        assertEquals(HOURS_RANGE_INVALID, specialHoursAddProblems("2026-12-24", "zz-99", today).hours)
        assertEquals(HOURS_RANGE_INVALID, specialHoursAddProblems("2026-12-24", "", today).hours)
        assertEquals(HOURS_RANGE_INVALID, specialHoursAddProblems("2026-12-24", "08:00|12:00", today).hours)
        assertEquals(HOURS_CLOSE_BEFORE_OPEN, specialHoursAddProblems("2026-12-24", "12:00-08:00", today).hours)
        assertNull(specialHoursAddProblems("2026-12-24", " 08:00 - 12:00 ", today).hours)
    }
}
