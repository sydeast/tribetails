package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors `mytribe/functions/test/closureRecurrence.test.ts` and
 * `auntieos-admin/src/lib/closureRecurrence.test.ts` exactly (same cases, same
 * expected dates), since this file is a verbatim port of that module. The
 * 2026-07-31 operator ruling: a US national holiday recurs yearly, so the
 * closures editor should not demand a fresh YYYY-MM-DD every January. These
 * tests pin the resolver's behavior, covering the two shapes that are subtle
 * enough to get wrong silently (Nth-weekday, last-weekday), the leap-day
 * policy, and a range crossing a year boundary.
 */
class ClosureRecurrenceTest {

    // ── parseClosureEntry: legacy `once` entries are untouched ──────────────

    @Test
    fun `plain YYYY-MM-DD or Name decodes exactly as before`() {
        val entry = parseClosureEntry("2026-12-25|Christmas closure")
        assertEquals(ClosureRecurrenceKind.ONCE, entry.recurrence)
        assertEquals("Christmas closure", entry.name)
        assertEquals("2026-12-25", entry.date)
    }

    @Test
    fun `a pipe inside the name still round-trips`() {
        val entry = parseClosureEntry("2026-12-25|Office closed | half day")
        assertEquals("Office closed | half day", entry.name)
    }

    @Test
    fun `no pipe at all- whole string is the name, blank date`() {
        val entry = parseClosureEntry("malformed entry")
        assertEquals(ClosureRecurrenceKind.ONCE, entry.recurrence)
        assertEquals("malformed entry", entry.name)
        assertEquals("", entry.date)
    }

    @Test
    fun `a bare date with no pipe is ALSO the no-pipe fallback`() {
        val entry = parseClosureEntry("2026-12-25")
        assertEquals("", entry.date)
        assertEquals("2026-12-25", entry.name)
    }

    // ── parseClosureEntry: new yearly shapes ─────────────────────────────────

    @Test
    fun `yearly-fixed parses month and day`() {
        val entry = parseClosureEntry("yearly:07-04|Independence Day")
        assertEquals(ClosureRecurrenceKind.YEARLY_FIXED, entry.recurrence)
        assertEquals("Independence Day", entry.name)
        assertEquals(7, entry.month)
        assertEquals(4, entry.day)
    }

    @Test
    fun `yearly-nth-weekday parses month, weekday, nth`() {
        val entry = parseClosureEntry("yearly-nth:11-4-4|Thanksgiving")
        assertEquals(ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, entry.recurrence)
        assertEquals(11, entry.month)
        assertEquals(4, entry.weekday)
        assertEquals(4, entry.nth)
    }

    @Test
    fun `yearly-last-weekday parses month and weekday`() {
        val entry = parseClosureEntry("yearly-last:05-1|Memorial Day")
        assertEquals(ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY, entry.recurrence)
        assertEquals(5, entry.month)
        assertEquals(1, entry.weekday)
    }

    // ── parseClosureEntry: malformed / out-of-range shapes fall back ────────

    @Test
    fun `an out-of-range month falls back to once with the whole string as name`() {
        val raw = "yearly:13-04|Bad month"
        val entry = parseClosureEntry(raw)
        assertEquals(ClosureRecurrenceKind.ONCE, entry.recurrence)
        assertEquals(raw, entry.name)
        assertEquals("", entry.date)
    }

    @Test
    fun `a day that does not exist in ANY year (Feb 30) falls back`() {
        val raw = "yearly:02-30|Bad day"
        val entry = parseClosureEntry(raw)
        assertEquals(ClosureRecurrenceKind.ONCE, entry.recurrence)
        assertEquals(raw, entry.name)
    }

    @Test
    fun `an out-of-range weekday or nth never matches the regex, and falls back`() {
        val raw = "yearly-nth:11-8-5|Bad weekday and nth"
        val entry = parseClosureEntry(raw)
        assertEquals(ClosureRecurrenceKind.ONCE, entry.recurrence)
        assertEquals(raw, entry.name)
    }

    // ── formatClosureEntry: the inverse of parseClosureEntry ────────────────

    @Test
    fun `format once`() {
        val wire = formatClosureEntry(ClosureEntry(ClosureRecurrenceKind.ONCE, name = "Office closed", date = "2026-09-14"))
        assertEquals("2026-09-14|Office closed", wire)
    }

    @Test
    fun `format yearly-fixed zero-pads month and day`() {
        val wire = formatClosureEntry(
            ClosureEntry(ClosureRecurrenceKind.YEARLY_FIXED, name = "Independence Day", month = 7, day = 4),
        )
        assertEquals("yearly:07-04|Independence Day", wire)
    }

    @Test
    fun `format yearly-nth-weekday`() {
        val wire = formatClosureEntry(
            ClosureEntry(ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, name = "Thanksgiving", month = 11, weekday = 4, nth = 4),
        )
        assertEquals("yearly-nth:11-4-4|Thanksgiving", wire)
    }

    @Test
    fun `format yearly-last-weekday`() {
        val wire = formatClosureEntry(
            ClosureEntry(ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY, name = "Memorial Day", month = 5, weekday = 1),
        )
        assertEquals("yearly-last:05-1|Memorial Day", wire)
    }

    @Test
    fun `every preset round-trips through parseClosureEntry`() {
        for (preset in US_HOLIDAY_PRESETS) {
            val entry = closureEntryFromPreset(preset)
            val wire = formatClosureEntry(entry)
            assertEquals(entry, parseClosureEntry(wire))
        }
    }

    // ── describeClosureRecurrence ────────────────────────────────────────────

    @Test
    fun `describe once is the bare date`() {
        assertEquals("2026-09-14", describeClosureRecurrence(parseClosureEntry("2026-09-14|Surgery")))
    }

    @Test
    fun `describe yearly-fixed`() {
        assertEquals(
            "Every year, July 4",
            describeClosureRecurrence(parseClosureEntry("yearly:07-04|Independence Day")),
        )
    }

    @Test
    fun `describe yearly-nth-weekday`() {
        assertEquals(
            "Every year, 4th Thursday of November",
            describeClosureRecurrence(parseClosureEntry("yearly-nth:11-4-4|Thanksgiving")),
        )
    }

    @Test
    fun `describe yearly-last-weekday`() {
        assertEquals(
            "Every year, last Monday of May",
            describeClosureRecurrence(parseClosureEntry("yearly-last:05-1|Memorial Day")),
        )
    }

    // ── closureDateInYear: Thanksgiving (4th Thursday of November) ──────────

    private val thanksgiving = closureEntryFromPreset(US_HOLIDAY_PRESETS.first { it.id == "thanksgiving" })
    private val memorial = closureEntryFromPreset(US_HOLIDAY_PRESETS.first { it.id == "memorial" })

    @Test
    fun `thanksgiving 2026-11-26`() {
        assertEquals("2026-11-26", closureDateInYear(thanksgiving, 2026))
    }

    @Test
    fun `thanksgiving 2027-11-25`() {
        assertEquals("2027-11-25", closureDateInYear(thanksgiving, 2027))
    }

    @Test
    fun `memorial day 2026-05-25`() {
        assertEquals("2026-05-25", closureDateInYear(memorial, 2026))
    }

    @Test
    fun `memorial day 2027-05-31`() {
        assertEquals("2027-05-31", closureDateInYear(memorial, 2027))
    }

    // ── leap-day policy ───────────────────────────────────────────────────────

    private val leapEntry = ClosureEntry(ClosureRecurrenceKind.YEARLY_FIXED, name = "Leap day closure", month = 2, day = 29)

    @Test
    fun `leap day resolves to Feb 29 in a leap year`() {
        assertEquals("2028-02-29", closureDateInYear(leapEntry, 2028))
    }

    @Test
    fun `CHOSEN POLICY- leap day resolves to Feb 28 in a non-leap year, not Mar 1`() {
        assertEquals("2026-02-28", closureDateInYear(leapEntry, 2026))
        assertEquals("2027-02-28", closureDateInYear(leapEntry, 2027))
    }

    // ── closureOccurrencesInRange ─────────────────────────────────────────────

    @Test
    fun `once entry inside and outside a range`() {
        val entry = parseClosureEntry("2026-09-14|Surgery")
        assertEquals(listOf("2026-09-14"), closureOccurrencesInRange(entry, "2026-01-01", "2026-12-31"))
        assertTrue(closureOccurrencesInRange(entry, "2027-01-01", "2027-12-31").isEmpty())
    }

    @Test
    fun `an empty range (start after end) is always empty`() {
        val entry = parseClosureEntry("yearly:07-04|Independence Day")
        assertTrue(closureOccurrencesInRange(entry, "2026-12-31", "2026-01-01").isEmpty())
    }

    @Test
    fun `a Dec-to-Jan window catches both the ending year Christmas and the following year New Year`() {
        val christmas = closureEntryFromPreset(US_HOLIDAY_PRESETS.first { it.id == "christmas" })
        val newYears = closureEntryFromPreset(US_HOLIDAY_PRESETS.first { it.id == "new_years" })

        assertEquals(listOf("2026-12-25"), closureOccurrencesInRange(christmas, "2026-12-20", "2027-01-10"))
        assertEquals(listOf("2027-01-01"), closureOccurrencesInRange(newYears, "2026-12-20", "2027-01-10"))
    }

    @Test
    fun `a multi-year range returns every occurrence, one per year touched`() {
        val independence = closureEntryFromPreset(US_HOLIDAY_PRESETS.first { it.id == "independence" })
        assertEquals(
            listOf("2025-07-04", "2026-07-04", "2027-07-04", "2028-07-04"),
            closureOccurrencesInRange(independence, "2025-01-01", "2028-12-31"),
        )
    }

    @Test
    fun `thanksgiving across the 2026-2027 boundary resolves to two distinct dates`() {
        assertEquals(
            listOf("2026-11-26", "2027-11-25"),
            closureOccurrencesInRange(thanksgiving, "2026-01-01", "2027-12-31"),
        )
    }

    // ── nextClosureOccurrence ─────────────────────────────────────────────────

    @Test
    fun `a once entry in the future`() {
        assertEquals("2026-09-14", nextClosureOccurrence(parseClosureEntry("2026-09-14|Surgery"), "2026-01-01"))
    }

    @Test
    fun `a once entry already in the past is null`() {
        assertNull(nextClosureOccurrence(parseClosureEntry("2026-09-14|Surgery"), "2026-10-01"))
    }

    @Test
    fun `a yearly entry queried after this year rolls to next year`() {
        val independence = closureEntryFromPreset(US_HOLIDAY_PRESETS.first { it.id == "independence" })
        assertEquals("2027-07-04", nextClosureOccurrence(independence, "2026-08-01"))
    }

    // ── US_HOLIDAY_PRESETS: the full ruling catalog resolves correctly ──────

    @Test
    fun `exactly eleven presets`() {
        assertEquals(11, US_HOLIDAY_PRESETS.size)
    }

    @Test
    fun `every preset resolves to its expected 2026 date`() {
        val expected2026 = mapOf(
            "new_years" to "2026-01-01",
            "mlk" to "2026-01-19",
            "presidents" to "2026-02-16",
            "memorial" to "2026-05-25",
            "juneteenth" to "2026-06-19",
            "independence" to "2026-07-04",
            "labor" to "2026-09-07",
            "indigenous_columbus" to "2026-10-12",
            "veterans" to "2026-11-11",
            "thanksgiving" to "2026-11-26",
            "christmas" to "2026-12-25",
        )
        for (preset in US_HOLIDAY_PRESETS) {
            val entry = closureEntryFromPreset(preset)
            assertEquals(preset.id, expected2026[preset.id], closureDateInYear(entry, 2026))
        }
    }

    // ── companyHolidayAddEnabled: the TimeOffPanel Add gate ──────────────────

    @Test
    fun `once- enabled only with a 10-char date and a clean name`() {
        assertTrue(
            companyHolidayAddEnabled(ClosureRecurrenceKind.ONCE, "Office closed", "2026-09-14", null, null, null, null),
        )
        assertFalse(
            companyHolidayAddEnabled(ClosureRecurrenceKind.ONCE, "Office closed", "9/14/26", null, null, null, null),
        )
        assertFalse(
            companyHolidayAddEnabled(ClosureRecurrenceKind.ONCE, "", "2026-09-14", null, null, null, null),
        )
        assertFalse(
            companyHolidayAddEnabled(ClosureRecurrenceKind.ONCE, "Bad|Name", "2026-09-14", null, null, null, null),
        )
    }

    @Test
    fun `yearly-fixed- needs month AND day picked, never a date string`() {
        assertFalse(
            companyHolidayAddEnabled(ClosureRecurrenceKind.YEARLY_FIXED, "Independence Day", "", null, null, null, null),
        )
        assertFalse(
            companyHolidayAddEnabled(ClosureRecurrenceKind.YEARLY_FIXED, "Independence Day", "", month = 7, day = null, weekday = null, nth = null),
        )
        assertTrue(
            companyHolidayAddEnabled(ClosureRecurrenceKind.YEARLY_FIXED, "Independence Day", "", month = 7, day = 4, weekday = null, nth = null),
        )
    }

    @Test
    fun `yearly-nth-weekday- needs month, weekday, AND nth all picked`() {
        assertFalse(
            companyHolidayAddEnabled(ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, "Thanksgiving", "", month = 11, day = null, weekday = 4, nth = null),
        )
        assertTrue(
            companyHolidayAddEnabled(ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, "Thanksgiving", "", month = 11, day = null, weekday = 4, nth = 4),
        )
    }

    @Test
    fun `yearly-last-weekday- needs only month and weekday, no nth required`() {
        assertFalse(
            companyHolidayAddEnabled(ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY, "Memorial Day", "", month = 5, day = null, weekday = null, nth = null),
        )
        assertTrue(
            companyHolidayAddEnabled(ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY, "Memorial Day", "", month = 5, day = null, weekday = 1, nth = null),
        )
    }
}
