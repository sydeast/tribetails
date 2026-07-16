package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessHours
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for business-hours decision logic (used by AdminSettingsScreen
 * BusinessHoursSection). Web canonical stores hours as `Map<DayOfWeek, String>`
 * like "09:00-17:00"; Android stores typed `List<BusinessHours>` (one per day).
 */
class BusinessHoursHelpersTest {

    // ─── parseTimeOrNull (HH:mm 24-hour) ───────────────────────────────────────

    @Test
    fun `parseTimeOrNull accepts valid HHmm`() {
        assertEquals(0 to 0,    parseTimeOrNull("00:00"))
        assertEquals(9 to 0,    parseTimeOrNull("09:00"))
        assertEquals(13 to 30,  parseTimeOrNull("13:30"))
        assertEquals(23 to 59,  parseTimeOrNull("23:59"))
    }

    @Test
    fun `parseTimeOrNull rejects malformed input`() {
        assertNull(parseTimeOrNull(""))
        assertNull(parseTimeOrNull("9:00"))      // missing leading 0
        assertNull(parseTimeOrNull("24:00"))     // hour out of range
        assertNull(parseTimeOrNull("12:60"))     // minute out of range
        assertNull(parseTimeOrNull("ab:cd"))
        assertNull(parseTimeOrNull("12-30"))
    }

    // ─── isValidTimeRange (open < close, when day is open) ─────────────────────

    @Test
    fun `isValidTimeRange true when open before close`() {
        assertTrue(isValidTimeRange("09:00", "17:00"))
        assertTrue(isValidTimeRange("00:00", "23:59"))
    }

    @Test
    fun `isValidTimeRange false when open equals or after close`() {
        assertFalse(isValidTimeRange("17:00", "17:00"))
        assertFalse(isValidTimeRange("18:00", "09:00"))
    }

    @Test
    fun `isValidTimeRange false when either time malformed`() {
        assertFalse(isValidTimeRange("bad",   "17:00"))
        assertFalse(isValidTimeRange("09:00", "bad"))
    }

    // ─── formatHoursDisplay (mirror web "09:00-17:00" / "Closed") ──────────────

    @Test
    fun `formatHoursDisplay shows en-dash range when open`() {
        val h = BusinessHours(dayOfWeek = 1, isOpen = true, openTime = "09:00", closeTime = "17:00")
        assertEquals("09:00-17:00", formatHoursDisplay(h))
    }

    @Test
    fun `formatHoursDisplay shows Closed when not open`() {
        val h = BusinessHours(dayOfWeek = 6, isOpen = false, openTime = "09:00", closeTime = "17:00")
        assertEquals("Closed", formatHoursDisplay(h))
    }

    // ─── ensureSevenDays (auto-fill missing weekdays w/ defaults) ──────────────

    @Test
    fun `ensureSevenDays returns empty input as 7 default rows ordered 1 to 7`() {
        val filled = ensureSevenDays(emptyList())
        assertEquals(7, filled.size)
        assertEquals(listOf(1, 2, 3, 4, 5, 6, 7), filled.map { it.dayOfWeek })
        // Default: Mon-Fri open, Sat-Sun closed (matches ServiceRepository default)
        assertTrue(filled.first { it.dayOfWeek == 1 }.isOpen)
        assertTrue(filled.first { it.dayOfWeek == 5 }.isOpen)
        assertFalse(filled.first { it.dayOfWeek == 6 }.isOpen)
        assertFalse(filled.first { it.dayOfWeek == 7 }.isOpen)
    }

    @Test
    fun `ensureSevenDays preserves existing rows and fills missing days`() {
        val mon = BusinessHours(dayOfWeek = 1, isOpen = true, openTime = "10:00", closeTime = "18:00")
        val filled = ensureSevenDays(listOf(mon))
        assertEquals(7, filled.size)
        val mondayBack = filled.first { it.dayOfWeek == 1 }
        assertEquals("10:00", mondayBack.openTime)
        assertEquals("18:00", mondayBack.closeTime)
    }
}
