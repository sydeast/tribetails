package com.tribetails.auntieos.web.screens.settings

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The desktop console's yearly-rule reader (`ClosureRecurrence.kt`, #1979) is a
 * port of the Android reader, so it carries the Android
 * `ClosureRecurrenceTest` read cases with the same expected dates (which in
 * turn mirror `auntieos-admin/src/lib/closureRecurrence.test.ts` and
 * `mytribe/functions/test/closureRecurrence.test.ts`). Extra dates were read
 * off a printed calendar, not off this code.
 */
class ClosureRecurrenceTest {

    private fun preset(id: String): ClosureEntry {
        val p = US_HOLIDAY_PRESETS.first { it.id == id }
        return ClosureEntry(p.recurrence, name = p.name, month = p.month, day = p.day, weekday = p.weekday, nth = p.nth)
    }

    /** The wire string the web and Android chips write for a preset. */
    private fun presetWire(p: ClosurePreset): String = when (p.recurrence) {
        ClosureRecurrenceKind.ONCE -> error("no one-time preset")
        ClosureRecurrenceKind.YEARLY_FIXED -> "yearly:${p.month.toString().padStart(2, '0')}-${p.day.toString().padStart(2, '0')}|${p.name}"
        ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY -> "yearly-nth:${p.month.toString().padStart(2, '0')}-${p.weekday}-${p.nth}|${p.name}"
        ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY -> "yearly-last:${p.month.toString().padStart(2, '0')}-${p.weekday}|${p.name}"
    }

    private fun assertUnreadable(raw: String) {
        val entry = parseClosureEntry(raw)
        assertEquals(ClosureRecurrenceKind.ONCE, entry.recurrence, raw)
        assertEquals(raw, entry.name, raw)
        assertEquals("", entry.date, raw)
    }

    // ── parse: one-time entries ─────────────────────────────────────────────

    @Test
    fun oneTimeEntryDecodes() {
        val entry = parseClosureEntry("2026-12-25|Christmas closure")
        assertEquals(ClosureRecurrenceKind.ONCE, entry.recurrence)
        assertEquals("Christmas closure", entry.name)
        assertEquals("2026-12-25", entry.date)
    }

    @Test
    fun aPipeInsideTheNameIsKept() {
        assertEquals("Office closed | half day", parseClosureEntry("2026-12-25|Office closed | half day").name)
    }

    @Test
    fun noPipeIsUnreadable() {
        assertUnreadable("malformed entry")
        assertUnreadable("2026-12-25")
    }

    // ── parse: yearly shapes ────────────────────────────────────────────────

    @Test
    fun yearlyFixedDecodes() {
        val entry = parseClosureEntry("yearly:07-04|Independence Day")
        assertEquals(ClosureRecurrenceKind.YEARLY_FIXED, entry.recurrence)
        assertEquals("Independence Day", entry.name)
        assertEquals(7, entry.month)
        assertEquals(4, entry.day)
    }

    @Test
    fun yearlyNthWeekdayDecodes() {
        val entry = parseClosureEntry("yearly-nth:11-4-4|Thanksgiving")
        assertEquals(ClosureRecurrenceKind.YEARLY_NTH_WEEKDAY, entry.recurrence)
        assertEquals(11, entry.month)
        assertEquals(4, entry.weekday)
        assertEquals(4, entry.nth)
    }

    @Test
    fun yearlyLastWeekdayDecodes() {
        val entry = parseClosureEntry("yearly-last:05-1|Memorial Day")
        assertEquals(ClosureRecurrenceKind.YEARLY_LAST_WEEKDAY, entry.recurrence)
        assertEquals(5, entry.month)
        assertEquals(1, entry.weekday)
    }

    @Test
    fun everyPresetChipEntryDecodesToItsRule() {
        for (p in US_HOLIDAY_PRESETS) {
            assertEquals(preset(p.id), parseClosureEntry(presetWire(p)), p.id)
        }
    }

    // ── parse: bad shapes read as unreadable, never as a wrong date ─────────

    @Test
    fun outOfRangeShapesAreUnreadable() {
        assertUnreadable("yearly:13-04|Bad month")
        assertUnreadable("yearly:00-04|Zero month")
        assertUnreadable("yearly:02-30|Bad day")
        assertUnreadable("yearly:04-31|April 31")
        assertUnreadable("yearly-nth:11-8-5|Bad weekday and nth")
        assertUnreadable("yearly-nth:11-4-5|Fifth Thursday")
        assertUnreadable("yearly-last:05-8|Bad weekday")
        assertUnreadable("yearly:7-04|Unpadded month")
        assertUnreadable("monthly:07-04|Unknown rule")
    }

    // ── describe ────────────────────────────────────────────────────────────

    @Test
    fun describesEachShape() {
        assertEquals("2026-09-14", describeClosureRecurrence(parseClosureEntry("2026-09-14|Surgery")))
        assertEquals("Every year, July 4", describeClosureRecurrence(parseClosureEntry("yearly:07-04|Independence Day")))
        assertEquals(
            "Every year, 4th Thursday of November",
            describeClosureRecurrence(parseClosureEntry("yearly-nth:11-4-4|Thanksgiving")),
        )
        assertEquals(
            "Every year, last Monday of May",
            describeClosureRecurrence(parseClosureEntry("yearly-last:05-1|Memorial Day")),
        )
    }

    // ── closureDateInYear ───────────────────────────────────────────────────

    @Test
    fun nthAndLastWeekdayDates() {
        assertEquals("2026-11-26", closureDateInYear(preset("thanksgiving"), 2026))
        assertEquals("2027-11-25", closureDateInYear(preset("thanksgiving"), 2027))
        assertEquals("2026-05-25", closureDateInYear(preset("memorial"), 2026))
        assertEquals("2027-05-31", closureDateInYear(preset("memorial"), 2027))
        assertEquals("2027-01-18", closureDateInYear(preset("mlk"), 2027))
        // The month starts on the weekday asked for: Oct 1 2027 is a Friday.
        assertEquals("2027-10-01", closureDateInYear(parseClosureEntry("yearly-nth:10-5-1|First Friday"), 2027))
        // The month ends on the weekday asked for: Jan 31 2027 is a Sunday.
        assertEquals("2027-01-31", closureDateInYear(parseClosureEntry("yearly-last:01-7|Last Sunday"), 2027))
    }

    @Test
    fun leapDayIsFeb29InALeapYearAndFeb28Otherwise() {
        val leap = parseClosureEntry("yearly:02-29|Leap day closure")
        assertEquals(ClosureRecurrenceKind.YEARLY_FIXED, leap.recurrence)
        assertEquals("2028-02-29", closureDateInYear(leap, 2028))
        assertEquals("2026-02-28", closureDateInYear(leap, 2026))
        assertEquals("2027-02-28", closureDateInYear(leap, 2027))
    }

    @Test
    fun everyPresetResolvesToItsExpected2026Date() {
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
        assertEquals(expected2026.keys, US_HOLIDAY_PRESETS.map { it.id }.toSet())
        for (p in US_HOLIDAY_PRESETS) {
            assertEquals(expected2026[p.id], closureDateInYear(preset(p.id), 2026), p.id)
        }
    }

    // ── nextClosureOccurrence ───────────────────────────────────────────────

    @Test
    fun oneTimeEntriesAheadAndPassed() {
        assertEquals("2026-09-14", nextClosureOccurrence(parseClosureEntry("2026-09-14|Surgery"), "2026-01-01"))
        assertEquals("2026-09-14", nextClosureOccurrence(parseClosureEntry("2026-09-14|Surgery"), "2026-09-14"))
        assertNull(nextClosureOccurrence(parseClosureEntry("2026-09-14|Surgery"), "2026-10-01"))
        assertNull(nextClosureOccurrence(parseClosureEntry("not a closure"), "2026-01-01"))
    }

    @Test
    fun aYearlyRuleRollsToNextYearOnceThisYearsDateHasPassed() {
        assertEquals("2027-07-04", nextClosureOccurrence(preset("independence"), "2026-08-01"))
        assertEquals("2026-11-26", nextClosureOccurrence(preset("thanksgiving"), "2026-11-26"))
        assertEquals("2027-11-25", nextClosureOccurrence(preset("thanksgiving"), "2026-11-27"))
    }

    @Test
    fun yearBoundary() {
        val yearEnd = parseClosureEntry("yearly:12-31|Year end")
        val newYear = preset("new_years")
        assertEquals("2026-12-31", nextClosureOccurrence(yearEnd, "2026-12-31"))
        assertEquals("2027-01-01", nextClosureOccurrence(newYear, "2026-12-31"))
        assertEquals("2027-12-31", nextClosureOccurrence(yearEnd, "2027-01-01"))
        assertEquals("2027-01-01", nextClosureOccurrence(newYear, "2027-01-01"))
        // The list order flips between those two days.
        val stored = listOf("yearly:01-01|New Year's Day", "yearly:12-31|Year end")
        assertEquals(listOf("Year end", "New Year's Day"), companyHolidayRows(stored, "2026-12-31").map { it.closure.name })
        assertEquals(listOf("New Year's Day", "Year end"), companyHolidayRows(stored, "2027-01-01").map { it.closure.name })
    }

    @Test
    fun leapDayNextOccurrence() {
        val leap = parseClosureEntry("yearly:02-29|Leap day closure")
        assertEquals("2027-02-28", nextClosureOccurrence(leap, "2026-03-01"))
        assertEquals("2028-02-29", nextClosureOccurrence(leap, "2027-03-01"))
        assertEquals("2028-02-29", nextClosureOccurrence(leap, "2028-02-29"))
    }
}
