package com.kinfolk.portal.screens.schedule

import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Stage 3 / 16.3 - pure weekly-recurrence expansion + validation. */
class RecurringBookingTest {

    private val utc = TimeZone.UTC
    // A fixed midnight reference so "today 09:00" is always in the future.
    private fun midnightMs(y: Int, m: Int, d: Int): Long =
        LocalDateTime(y, m, d, 0, 0).toInstant(utc).toEpochMilliseconds()

    @Test
    fun expandsEveryChosenWeekdayForEachWeek() {
        val now = midnightMs(2026, 6, 1)
        val visits = buildWeeklyVisits(
            nowMs = now, weeklyDays = (0..6).toSet(), weeks = 1, time = LocalTime(9, 0),
            serviceId = "s1", serviceName = "Walk", priceCents = 1000, tz = utc,
        )
        // All 7 weekdays, one week, all at 09:00 > midnight -> 7 future visits.
        assertEquals(7, visits.size)
        // strictly ascending by start time
        assertTrue(visits.zipWithNext().all { (a, b) -> a.startTimeMs < b.startTimeMs })
        assertTrue(visits.all { it.startTimeMs > now && it.serviceId == "s1" && it.priceCents == 1000L })
    }

    @Test
    fun twoDaysTwoWeeksGivesFour() {
        val now = midnightMs(2026, 6, 1)
        val day0 = weekdayIndex(kotlinx.datetime.LocalDate(2026, 6, 1))
        val day2 = (day0 + 2) % 7
        val visits = buildWeeklyVisits(now, setOf(day0, day2), 2, LocalTime(8, 30), "s", "n", null, utc)
        assertEquals(4, visits.size)
    }

    @Test
    fun pastOccurrencesAreFiltered() {
        // now = a day at 10:00; only that same weekday at 09:00 would match within
        // 1 week, but 09:00 < 10:00 (past) and it doesn't recur again until week 2.
        val today = kotlinx.datetime.LocalDate(2026, 6, 1)
        val now = LocalDateTime(2026, 6, 1, 10, 0).toInstant(utc).toEpochMilliseconds()
        val visits = buildWeeklyVisits(now, setOf(weekdayIndex(today)), 1, LocalTime(9, 0), "s", "n", null, utc)
        assertEquals(0, visits.size)
    }

    @Test
    fun capsAtMax() {
        val now = midnightMs(2026, 6, 1)
        val visits = buildWeeklyVisits(now, (0..6).toSet(), 8, LocalTime(9, 0), "s", "n", null, utc)
        assertEquals(MAX_RECURRING_VISITS, visits.size) // 56 potential -> capped to 26
    }

    @Test
    fun potentialCountExposesTruncation() {
        // weeklyPotentialCount is the INTENDED count (days x weeks); when it exceeds
        // the emitted size, the wizard surfaces a fail-loud cap warning.
        assertEquals(56, weeklyPotentialCount((0..6).toSet(), 8))
        assertEquals(8, weeklyPotentialCount(setOf(1, 3), 4))
        assertEquals(0, weeklyPotentialCount(setOf(1), 0))
        val now = midnightMs(2026, 6, 1)
        val emitted = buildWeeklyVisits(now, (0..6).toSet(), 8, LocalTime(9, 0), "s", "n", null, utc).size
        assertTrue(weeklyPotentialCount((0..6).toSet(), 8) > emitted) // truncation is detectable
    }

    @Test
    fun emptyDaysOrZeroWeeksYieldsNothing() {
        val now = midnightMs(2026, 6, 1)
        assertTrue(buildWeeklyVisits(now, emptySet(), 4, LocalTime(9, 0), "s", "n", null, utc).isEmpty())
        assertTrue(buildWeeklyVisits(now, setOf(1), 0, LocalTime(9, 0), "s", "n", null, utc).isEmpty())
    }

    @Test
    fun weeklyVisitsBlockerValidates() {
        assertNotNull(weeklyVisitsBlocker(emptySet(), 4, "09:00"))
        assertNotNull(weeklyVisitsBlocker(setOf(1), 0, "09:00"))
        assertNotNull(weeklyVisitsBlocker(setOf(1), 4, "bad"))
        assertNull(weeklyVisitsBlocker(setOf(1, 3), 4, "09:00"))
    }

    @Test
    fun parseHourMinute() {
        assertEquals(LocalTime(9, 30), parseHourMinuteOrNull("09:30"))
        assertNull(parseHourMinuteOrNull("9"))
        assertNull(parseHourMinuteOrNull("ab:cd"))
    }
}
