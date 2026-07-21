package com.tribetails.auntieos.web.screens.booking

import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * AO-25: pure date math for the New-booking-request form. Assertions are
 * zone-independent (counts, weekday convention, ordering), not exact epoch ms.
 */
class NewBookingMathTest {

    @Test
    fun jsWeekday_maps_monday_to_1_and_sunday_to_0() {
        assertEquals(1, NewBookingMath.jsWeekday(LocalDate(2027, 8, 2)))  // Monday
        assertEquals(0, NewBookingMath.jsWeekday(LocalDate(2027, 8, 1)))  // Sunday
        assertEquals(6, NewBookingMath.jsWeekday(LocalDate(2027, 8, 7)))  // Saturday
    }

    @Test
    fun expandWeekly_one_per_selected_weekday_per_week() {
        val ms = NewBookingMath.expandWeekly(
            startDate = LocalDate(2027, 8, 2),
            hour = 9, minute = 0,
            weekdays = setOf(1, 3), // Mon + Wed
            weeks = 2,
        )
        assertEquals(4, ms.size)
        assertEquals(ms.sorted(), ms)
    }

    @Test
    fun expandWeekly_empty_on_no_weekday_or_nonpositive_weeks() {
        assertTrue(NewBookingMath.expandWeekly(LocalDate(2027, 8, 2), 9, 0, emptySet(), 2).isEmpty())
        assertTrue(NewBookingMath.expandWeekly(LocalDate(2027, 8, 2), 9, 0, setOf(1), 0).isEmpty())
    }

    @Test
    fun visitMs_drops_nulls_dedupes_sorts() {
        val a = NewBookingMath.localMs(LocalDate(2027, 8, 3), 9, 0)
        val b = NewBookingMath.localMs(LocalDate(2027, 8, 10), 9, 0)
        val ms = NewBookingMath.visitMs(listOf(b, null, a, a))
        assertEquals(2, ms.size)
        assertTrue(ms[0] < ms[1])
    }

    @Test
    fun allInFuture_honors_one_minute_grace() {
        val now = 1_000_000_000_000L
        assertTrue(NewBookingMath.allInFuture(listOf(now + 1000, now + 5000), now))
        assertTrue(NewBookingMath.allInFuture(listOf(now - 30_000), now))
        assertFalse(NewBookingMath.allInFuture(listOf(now + 5000, now - 120_000), now))
    }
}
