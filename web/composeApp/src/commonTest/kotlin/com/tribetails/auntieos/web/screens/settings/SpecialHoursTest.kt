package com.tribetails.auntieos.web.screens.settings

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure-helper tests for special-hours add gating (spec 29 item 15.5): a valid
 * YYYY-MM-DD date + non-blank hours with no pipe (so the "date|hours" encoding
 * stays parseable).
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
