package com.tribetails.auntieos.ui.admin.scheduling
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.ui.admin.sortServiceTypesByDuration
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/**
 * #392 (operator mark 5, 2026-08-17 walk): the Schedule legend scoped to the
 * current calendar view, mirroring the web `Schedule.test.tsx` coverage for the
 * same bug so both platforms are pinned to identical behavior.
 */
class ScheduleLegendScopeTest {
    private fun booking(title: String, isoDateTime: String) =
        EnhancedBooking(baseServiceTitle = title, startDateTime = isoDateTime)
    // ── isDateInScheduleView ─────────────────────────────────────────────
    @Test
    fun dayViewIsExactlyTheSelectedDate() {
        val selected = LocalDate.of(2026, 8, 18)
        assertTrue(isDateInScheduleView(selected, selected, CalendarViewMode.DAY))
        assertFalse(isDateInScheduleView(selected.plusDays(1), selected, CalendarViewMode.DAY))
        assertFalse(isDateInScheduleView(selected.minusDays(1), selected, CalendarViewMode.DAY))
    }
    @Test
    fun weekViewIsTheMondayFirstWeekContainingSelected() {
        // 2026-08-18 is a Tuesday; its Monday-first week is Aug 17 to Aug 23.
        val selected = LocalDate.of(2026, 8, 18)
        assertTrue(isDateInScheduleView(LocalDate.of(2026, 8, 17), selected, CalendarViewMode.WEEK)) // Monday
        assertTrue(isDateInScheduleView(LocalDate.of(2026, 8, 23), selected, CalendarViewMode.WEEK)) // Sunday
        assertFalse(isDateInScheduleView(LocalDate.of(2026, 8, 16), selected, CalendarViewMode.WEEK)) // prior Sunday
        assertFalse(isDateInScheduleView(LocalDate.of(2026, 8, 24), selected, CalendarViewMode.WEEK)) // next Monday
    }
    @Test
    fun monthViewIsEveryDayOfSelectedsCalendarMonth() {
        val selected = LocalDate.of(2026, 8, 18)
        assertTrue(isDateInScheduleView(LocalDate.of(2026, 8, 1), selected, CalendarViewMode.MONTH))
        assertTrue(isDateInScheduleView(LocalDate.of(2026, 8, 31), selected, CalendarViewMode.MONTH))
        assertFalse(isDateInScheduleView(LocalDate.of(2026, 7, 31), selected, CalendarViewMode.MONTH))
        assertFalse(isDateInScheduleView(LocalDate.of(2026, 9, 1), selected, CalendarViewMode.MONTH))
    }
    // ── bookingsInScheduleView ───────────────────────────────────────────
    @Test
    fun scopesToTheVisibleWeek_excludingABookingWeeksAway() {
        val selected = LocalDate.of(2026, 8, 18) // Tuesday
        val inView = booking("Dog Walk", "2026-08-19T09:00:00")
        val outOfView = booking("Overnight Stay", "2026-09-08T09:00:00") // 3 weeks later
        val result = bookingsInScheduleView(listOf(inView, outOfView), selected, CalendarViewMode.WEEK)
        assertEquals(listOf("Dog Walk"), result.map { it.baseServiceTitle })
    }
    @Test
    fun anEmptyViewReturnsNoBookingsEvenWhenTheStreamIsNonEmpty() {
        val selected = LocalDate.of(2026, 8, 18)
        val outOfView = booking("Overnight Stay", "2026-09-08T09:00:00")
        val result = bookingsInScheduleView(listOf(outOfView), selected, CalendarViewMode.WEEK)
        assertTrue(result.isEmpty())
    }
    @Test
    fun dropsABookingWithAnUnparseableStartDateTimeRatherThanGuessingItIntoView() {
        val selected = LocalDate.of(2026, 8, 18)
        val junk = booking("Dog Walk", "not-a-date")
        val blank = booking("Drop-in", "")
        val result = bookingsInScheduleView(listOf(junk, blank), selected, CalendarViewMode.WEEK)
        assertTrue(result.isEmpty())
    }
    // ── distinctServiceTypes ─────────────────────────────────────────────
    @Test
    fun distinctServiceTypesDedupesAndDropsBlanks() {
        assertEquals(
            listOf("Dog Walk", "Drop-in"),
            distinctServiceTypes(listOf("Drop-in", "Dog Walk", "Dog Walk", "  ", "")),
        )
    }
    @Test
    fun distinctServiceTypesTrimsBeforeDeduping() {
        assertEquals(listOf("Dog Walk"), distinctServiceTypes(listOf("Dog Walk", " Dog Walk ")))
    }
    // ── the full legend pipeline (scope + order), the two-of-five case ────
    @Test
    fun scopeThenDurationOrder_twoOfFiveConfiguredTypesRenderInDurationOrder() {
        val selected = LocalDate.of(2026, 8, 18)
        // Only 2 of 5 configured types are on screen; "Half-Day 6Hrs" (the
        // longer one) is listed FIRST in the booking stream, so passing
        // requires the duration sort, not stream order.
        val onScreen = listOf(
            booking("Half-Day 6Hrs", "2026-08-18T09:00:00"),
            booking("30Minute", "2026-08-19T09:00:00"),
        )
        val configuredButAbsent = listOf(
            booking("Consultation", "2026-09-08T09:00:00"),
            booking("90Minute", "2026-09-08T09:00:00"),
            booking("2Hrs", "2026-09-08T09:00:00"),
        )
        val durations = mapOf(
            "Half-Day 6Hrs" to "360",
            "30Minute" to "30",
            "Consultation" to "20",
            "90Minute" to "90",
            "2Hrs" to "120",
        )
        val inView = bookingsInScheduleView(onScreen + configuredButAbsent, selected, CalendarViewMode.WEEK)
        val legend = sortServiceTypesByDuration(
            distinctServiceTypes(inView.map { it.baseServiceTitle }),
            durations,
        )
        assertEquals(listOf("30Minute", "Half-Day 6Hrs"), legend)
    }
    @Test
    fun aTypeOnScreenButMissingFromServiceRatesStillGetsALegendRow() {
        val selected = LocalDate.of(2026, 8, 18)
        val inView = listOf(
            booking("30Minute", "2026-08-18T09:00:00"),
            booking("Off-Book Visit", "2026-08-19T09:00:00"),
        )
        val scoped = bookingsInScheduleView(inView, selected, CalendarViewMode.WEEK)
        val legend = sortServiceTypesByDuration(
            distinctServiceTypes(scoped.map { it.baseServiceTitle }),
            mapOf("30Minute" to "30"),
        )
        // Unconfigured and unparseable-by-name, so it has no resolvable
        // duration and sorts last -- but it is never dropped.
        assertEquals(listOf("30Minute", "Off-Book Visit"), legend)
    }
}
