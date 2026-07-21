package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for special-hours add gating (spec 29 item 15.5), mirroring
 * the web SpecialHoursTest: valid YYYY-MM-DD date + non-blank hours with no pipe.
 */
class SpecialHoursTest {

    @Test
    fun enabledOnValidDateAndHours() {
        assertTrue(specialHoursAddEnabled("2026-07-03", "08:00-12:00"))
    }

    @Test
    fun disabledOnBadDate() {
        assertFalse(specialHoursAddEnabled("7/3/26", "08:00-12:00"))
        assertFalse(specialHoursAddEnabled("", "08:00-12:00"))
    }

    @Test
    fun disabledOnBlankHours() {
        assertFalse(specialHoursAddEnabled("2026-07-03", ""))
    }

    @Test
    fun disabledWhenHoursContainPipe() {
        assertFalse(specialHoursAddEnabled("2026-07-03", "08:00|12:00"))
    }
}
