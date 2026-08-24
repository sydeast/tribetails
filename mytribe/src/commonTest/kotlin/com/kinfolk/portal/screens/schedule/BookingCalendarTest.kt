package com.kinfolk.portal.screens.schedule

import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #544 parity: these mirror the web assertions in
 * `mytribe/web/src/lib/bookingWizardLogic.test.ts` one for one, so the two
 * clients cannot drift on which dates a household is offered.
 */
class BookingCalendarTest {

    @Test
    fun monthDays_returnsEveryRealDayOfTheMonth() {
        val july = bookingMonthDays(LocalDate(2026, 7, 15))
        assertEquals(31, july.size)
        assertEquals(LocalDate(2026, 7, 1), july.first())
        assertEquals(LocalDate(2026, 7, 31), july.last())
    }

    /**
     * The old `daysToShow` handed back a flat 28 days from the 1st, which
     * silently dropped the 29th-31st of every long month: on the walk that
     * filed #544, August 2026 offered up to the 28th and stopped.
     */
    @Test
    fun monthDays_doesNotClipLongMonthsAndHandlesLeapFebruary() {
        assertEquals(31, bookingMonthDays(LocalDate(2026, 8, 1)).size)
        assertEquals(30, bookingMonthDays(LocalDate(2026, 9, 1)).size)
        assertEquals(28, bookingMonthDays(LocalDate(2026, 2, 1)).size)
        assertEquals(29, bookingMonthDays(LocalDate(2028, 2, 1)).size)
    }

    @Test
    fun horizonEnd_landsExactlyHorizonDaysAfterToday() {
        val today = LocalDate(2026, 8, 23)
        assertEquals(LocalDate(2026, 12, 21), bookingHorizonEnd(today, 120))
        assertEquals(LocalDate(2026, 8, 24), bookingHorizonEnd(today, 1))
    }

    @Test
    fun horizonDefault_matchesTheServersClosureRangeCap() {
        // No booking-horizon setting exists on business_settings; the bound is
        // getBusinessClosures' MAX_RANGE_DAYS. If that cap moves, this says so.
        assertEquals(120, BOOKING_HORIZON_DAYS)
    }

    @Test
    fun shiftMonth_rollsAcrossAYearBoundaryBothWays() {
        assertEquals(LocalDate(2027, 1, 1), shiftMonth(LocalDate(2026, 12, 15), 1))
        assertEquals(LocalDate(2025, 12, 1), shiftMonth(LocalDate(2026, 1, 15), -1))
    }

    @Test
    fun monthIndex_ordersMonthsAcrossYears() {
        assertTrue(monthIndex(LocalDate(2026, 12, 1)) < monthIndex(LocalDate(2027, 1, 1)))
        assertEquals(monthIndex(LocalDate(2026, 8, 1)), monthIndex(LocalDate(2026, 8, 31)))
    }

    @Test
    fun isBookableDay_acceptsTodayThroughHorizonAndRefusesEitherSide() {
        val today = LocalDate(2026, 8, 23)
        val end = bookingHorizonEnd(today, 120)
        assertFalse(isBookableDay(LocalDate(2026, 8, 22), today, end))
        assertTrue(isBookableDay(today, today, end))
        assertTrue(isBookableDay(LocalDate(2026, 11, 4), today, end))
        assertTrue(isBookableDay(LocalDate(2026, 12, 21), today, end))
        assertFalse(isBookableDay(LocalDate(2026, 12, 22), today, end))
    }

    @Test
    fun paging_isBoundedByTodaysMonthAndTheHorizonsMonth() {
        val today = LocalDate(2026, 8, 12)
        val end = bookingHorizonEnd(today, 40) // 2026-09-21
        assertFalse(canPageBack(LocalDate(2026, 8, 1), today))
        assertTrue(canPageBack(LocalDate(2026, 9, 1), today))
        assertTrue(canPageForward(LocalDate(2026, 8, 1), end))
        assertFalse(canPageForward(LocalDate(2026, 9, 1), end))
    }

    @Test
    fun dateKey_isZeroPaddedAndMatchesTheClosureWireFormat() {
        assertEquals("2026-01-05", bookingDateKey(LocalDate(2026, 1, 5)))
        assertEquals("2026-12-31", bookingDateKey(LocalDate(2026, 12, 31)))
    }
}
