package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.SettingsChecks
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure-helper tests for the Time off add rows (spec 29 item 15.5, #1593): a
 * special-hours entry needs a real date, today or later in the business's
 * zone, and HH:MM-HH:MM hours closing after opening; a closure needs the same
 * date and a name. Each refusal is the server's sentence, beside its field.
 */
class SpecialHoursTest {

    private val today = "2026-11-09"

    @Test
    fun enabledOnValidDateAndHours() {
        assertTrue(specialHoursAddEnabled("2026-12-24", "08:00-12:00", today))
        assertTrue(specialHoursAddEnabled(today, "8:00-12:00", today), "today counts, and 8:00 reads as 08:00")
    }

    @Test
    fun disabledOnBadDate() {
        assertFalse(specialHoursAddEnabled("7/3/26", "08:00-12:00", today))
        assertFalse(specialHoursAddEnabled("", "08:00-12:00", today))
        assertEquals(SettingsChecks.DATE_INVALID, specialHoursAddProblems("", "08:00-12:00", today).first)
    }

    @Test
    fun aDateTheCalendarDoesNotHaveIsRefused() {
        assertEquals(SettingsChecks.DATE_INVALID, specialHoursAddProblems("2026-13-45", "08:00-12:00", today).first)
        assertEquals(SettingsChecks.DATE_INVALID, specialHoursAddProblems("2026-02-30", "08:00-12:00", today).first)
        assertFalse(specialHoursAddEnabled("2026-02-30", "08:00-12:00", today))
    }

    @Test
    fun aPastDateIsRefused() {
        val p = specialHoursAddProblems("2026-11-08", "08:00-12:00", today)
        assertEquals(SettingsChecks.DATE_PAST, p.first)
        assertNull(p.second)
        assertFalse(p.ready)
    }

    @Test
    fun disabledOnBlankHours() {
        assertFalse(specialHoursAddEnabled("2026-12-24", "", today))
        assertEquals(SettingsChecks.HOURS_RANGE_INVALID, specialHoursAddProblems("2026-12-24", "", today).second)
    }

    @Test
    fun disabledWhenHoursContainPipe() {
        assertFalse(specialHoursAddEnabled("2026-12-24", "08:00|12:00", today))
    }

    @Test
    fun hoursThatDoNotReadOrCloseBeforeOpeningAreRefused() {
        assertEquals(SettingsChecks.HOURS_RANGE_INVALID, specialHoursAddProblems("2026-12-24", "zz-99", today).second)
        assertEquals(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN, specialHoursAddProblems("2026-12-24", "17:00-09:00", today).second)
        assertEquals(SettingsChecks.HOURS_CLOSE_BEFORE_OPEN, specialHoursAddProblems("2026-12-24", "09:00-09:00", today).second)
    }

    @Test
    fun anEmptyRowSaysNothingAndCannotBeAdded() {
        assertEquals(AddRowProblems(null, null, ready = false), specialHoursAddProblems("", "", today))
        assertEquals(AddRowProblems(null, null, ready = false), closureAddProblems("  ", "", today))
    }

    @Test
    fun aClosureNeedsARealFutureDateAndAName() {
        assertTrue(closureAddProblems("2026-12-25", "Christmas", today).ready)
        assertEquals(SettingsChecks.DATE_INVALID, closureAddProblems("2026-13-45", "Christmas", today).first)
        assertEquals(SettingsChecks.DATE_PAST, closureAddProblems("2026-01-01", "New Year", today).first)
        assertEquals(SettingsChecks.CLOSURE_NAME_REQUIRED, closureAddProblems("2026-12-25", " ", today).second)
        assertEquals(CLOSURE_NAME_PIPE, closureAddProblems("2026-12-25", "Shut|down", today).second)
        assertEquals(SettingsChecks.DATE_INVALID, closureAddProblems("", "Christmas", today).first, "a name with no date says why Add is off")
    }
}
