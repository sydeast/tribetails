package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.ui.admin.parseClosureEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * The Kotlin twin of `mytribe/functions/test/companyHolidayConflict.test.ts`.
 * Same cases, same names in spirit: the pure date math (`utcDatesForVisit`,
 * `findCompanyHolidayConflict`), yearly recurrence across a year boundary,
 * and the no-closures / open-day / corrupt-entry pass-through cases.
 */
class CompanyHolidayConflictTest {

    // ── utcDatesForVisit ──────────────────────────────────────────────────────

    @Test
    fun `a same-UTC-day window yields one date`() {
        val w = BusyConflictWindow(Instant.parse("2026-07-04T14:00:00Z"), Instant.parse("2026-07-04T15:00:00Z"))
        assertEquals(listOf("2026-07-04"), utcDatesForVisit(w))
    }

    @Test
    fun `a window crossing UTC midnight yields both days`() {
        val w = BusyConflictWindow(Instant.parse("2026-07-04T22:00:00Z"), Instant.parse("2026-07-05T02:00:00Z"))
        assertEquals(listOf("2026-07-04", "2026-07-05"), utcDatesForVisit(w))
    }

    @Test
    fun `a window ending exactly at UTC midnight does not touch the next day`() {
        val w = BusyConflictWindow(Instant.parse("2026-07-04T20:00:00Z"), Instant.parse("2026-07-05T00:00:00Z"))
        assertEquals(listOf("2026-07-04"), utcDatesForVisit(w))
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
        assertTrue(resolveVisitWindow("not-a-date", "2026-09-14T15:00:00Z") == null)
    }
}
