package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.ui.admin.parseClosureEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * The Kotlin twin of `mytribe/functions/test/companyHolidayConflict.test.ts`.
 * Same cases, same names in spirit: the pure date math (`businessDatesForVisit`,
 * `findCompanyHolidayConflict`), yearly recurrence across a year boundary,
 * and the no-closures / open-day / corrupt-entry pass-through cases.
 */
class CompanyHolidayConflictTest {

    // ── businessDatesForVisit (#1119) ─────────────────────────────────────────
    private val ny = "America/New_York"
    @Test
    fun `a 21h00 visit in a US zone is on its own business date, not the next UTC day`() {
        // 21:00 EDT on Jul 4 is 01:00Z on Jul 5.
        val w = BusyConflictWindow(Instant.parse("2026-07-05T01:00:00Z"), Instant.parse("2026-07-05T02:00:00Z"))
        assertEquals(listOf("2026-07-04"), businessDatesForVisit(w, ny))
        assertEquals(listOf("2026-07-05"), businessDatesForVisit(w, "UTC"))
    }
    @Test
    fun `a visit crossing business midnight covers both dates`() {
        // 22:00 EDT Jul 4 to 02:00 EDT Jul 5.
        val w = BusyConflictWindow(Instant.parse("2026-07-05T02:00:00Z"), Instant.parse("2026-07-05T06:00:00Z"))
        assertEquals(listOf("2026-07-04", "2026-07-05"), businessDatesForVisit(w, ny))
    }
    @Test
    fun `a window ending exactly at business midnight does not touch the next day`() {
        // 20:00 EDT Jul 4 to 00:00 EDT Jul 5.
        val w = BusyConflictWindow(Instant.parse("2026-07-05T00:00:00Z"), Instant.parse("2026-07-05T04:00:00Z"))
        assertEquals(listOf("2026-07-04"), businessDatesForVisit(w, ny))
    }
    @Test
    fun `a multi-day window lists every date including the middle one`() {
        val w = BusyConflictWindow(Instant.parse("2026-07-04T16:00:00Z"), Instant.parse("2026-07-06T16:00:00Z"))
        assertEquals(listOf("2026-07-04", "2026-07-05", "2026-07-06"), businessDatesForVisit(w, ny))
    }
    @Test
    fun `a spring-forward day is covered once and the days around it are not skipped`() {
        // US DST began 2026-03-08 (23h day). Mar 7 12:00 EST to Mar 9 12:00 EDT.
        val w = BusyConflictWindow(Instant.parse("2026-03-07T17:00:00Z"), Instant.parse("2026-03-09T16:00:00Z"))
        assertEquals(listOf("2026-03-07", "2026-03-08", "2026-03-09"), businessDatesForVisit(w, ny))
        // 23:30 EST Mar 7 to 01:30 EST Mar 8 (before the 02:00 gap) covers both dates.
        val late = BusyConflictWindow(Instant.parse("2026-03-08T04:30:00Z"), Instant.parse("2026-03-08T06:30:00Z"))
        assertEquals(listOf("2026-03-07", "2026-03-08"), businessDatesForVisit(late, ny))
    }
    @Test
    fun `a fall-back day is covered once and the days around it are not doubled`() {
        // US DST ended 2026-11-01 (25h day). Oct 31 12:00 EDT to Nov 2 12:00 EST.
        val w = BusyConflictWindow(Instant.parse("2026-10-31T16:00:00Z"), Instant.parse("2026-11-02T17:00:00Z"))
        assertEquals(listOf("2026-10-31", "2026-11-01", "2026-11-02"), businessDatesForVisit(w, ny))
    }
    @Test
    fun `a blank zone falls back to America-Chicago dates, the one default (#1109)`() {
        // 01:00Z Jul 5 is 20:00 CDT Jul 4.
        val w = BusyConflictWindow(Instant.parse("2026-07-05T01:00:00Z"), Instant.parse("2026-07-05T02:00:00Z"))
        assertEquals(listOf("2026-07-04"), businessDatesForVisit(w, ""))
        assertEquals(listOf("2026-07-04"), businessDatesForVisit(w, "   "))
    }
    @Test
    fun `an unusable zone falls back to America-Chicago dates, not UTC`() {
        val w = BusyConflictWindow(Instant.parse("2026-07-05T01:00:00Z"), Instant.parse("2026-07-05T02:00:00Z"))
        assertEquals(listOf("2026-07-04"), businessDatesForVisit(w, "Not/AZone"))
    }
    @Test
    fun `a window crossing UTC midnight in a UTC business yields both days`() {
        val w = BusyConflictWindow(Instant.parse("2026-07-04T22:00:00Z"), Instant.parse("2026-07-05T02:00:00Z"))
        assertEquals(listOf("2026-07-04", "2026-07-05"), businessDatesForVisit(w, "UTC"))
    }
    // ── findCompanyHolidayConflict ────────────────────────────────────────────

    @Test
    fun `flags a date landing on a once-dated closure`() {
        val entries = listOf(parseClosureEntry("2026-09-14|Owner away"))
        val hit = findCompanyHolidayConflict(listOf("2026-09-14"), entries)
        assertEquals("2026-09-14" to "Owner away", hit)
    }

    @Test
    fun `honors yearly recurrence ACROSS a year boundary`() {
        val entries = listOf(parseClosureEntry("yearly:07-04|Independence Day"))
        assertEquals("2026-07-04" to "Independence Day", findCompanyHolidayConflict(listOf("2026-07-04"), entries))
        assertEquals("2027-07-04" to "Independence Day", findCompanyHolidayConflict(listOf("2027-07-04"), entries))
        assertEquals("2031-07-04" to "Independence Day", findCompanyHolidayConflict(listOf("2031-07-04"), entries))
    }

    @Test
    fun `no match on an open day`() {
        val entries = listOf(parseClosureEntry("2026-09-14|Closed"))
        assertNull(findCompanyHolidayConflict(listOf("2026-09-15"), entries))
    }

    @Test
    fun `no entries at all means no conflict`() {
        assertNull(findCompanyHolidayConflict(listOf("2026-09-14"), emptyList()))
    }

    @Test
    fun `a blank closure name falls back to a readable label`() {
        val entries = listOf(parseClosureEntry("2026-09-14|"))
        assertEquals("2026-09-14" to "a company holiday", findCompanyHolidayConflict(listOf("2026-09-14"), entries))
    }

    @Test
    fun `a corrupt entry decodes to the safe once-blank fallback and never matches any date`() {
        val entries = listOf(parseClosureEntry("garbage-not-a-real-entry"))
        assertNull(findCompanyHolidayConflict(listOf("2026-09-14"), entries))
    }

    // ── assertNoCompanyHolidayConflict (window resolution edge) ─────────────────

    @Test
    fun `an unparseable start resolves to no window at all, via resolveVisitWindow`() {
        assertTrue(resolveVisitWindow("not-a-date", "2026-09-14T15:00:00Z", java.time.ZoneOffset.UTC) == null)
    }
}
