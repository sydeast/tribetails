package com.tribetails.auntieos.ui.admin.scheduling
import com.tribetails.auntieos.data.model.EnhancedBooking
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.YearMonth
import java.time.format.DateTimeFormatter
/**
 * #392 (operator mark 5, 2026-08-17 walk): the Schedule legend scoped to the
 * CURRENT calendar view, ported from the web fix
 * (`Schedule.tsx#daysInView` + `lib/scheduleFormat.ts#distinctServiceTypes`) so
 * both platforms answer "what's actually on screen right now", never "what did
 * the operator configure in Settings" and never "what's anywhere in the whole
 * loaded stream". Duration ORDER is unchanged and untouched by this file --
 * `sortServiceTypesByDuration` (`ServiceTypeSort.kt`) still owns that, over
 * whatever list of type names this file hands it.
 */
/**
 * True when [date] falls inside the visible calendar range for [viewMode]
 * anchored at [selected]. Mirrors the ranges the three calendar surfaces below
 * the legend (`ScheduleViewScreen.kt`) already render, so the legend can never
 * disagree with what the grid itself shows:
 *  - DAY: exactly `selected` -- there is no separate day grid, the agenda above
 *    the legend IS the view.
 *  - WEEK: the Monday-first week containing `selected`, the same range
 *    `androidWeekStripDays`/`AndroidWeekStrip` draws.
 *  - MONTH: every day of `selected`'s calendar month. `EnhancedMonthView` never
 *    pads in adjacent-month days (blank cells only before day 1 and after the
 *    month's last day, nothing rendered from another month), so "the visible
 *    month" is exactly that `YearMonth` -- unlike web's 6-week Monday-anchored
 *    grid, which does show a few adjacent-month days.
 *  - AGENDA: unreachable from the view picker
 *    (`CalendarViewMode.entries.filter { it != AGENDA }` in
 *    `ScheduleViewScreen.kt`), so this is a declared default rather than a real
 *    behavior anyone can trigger: falls back to DAY's single-day rule instead
 *    of throwing on a mode nothing can currently select.
 */
fun isDateInScheduleView(date: LocalDate, selected: LocalDate, viewMode: CalendarViewMode): Boolean =
    when (viewMode) {
        CalendarViewMode.WEEK -> {
            val monday = selected.minusDays((selected.dayOfWeek.value - 1).toLong())
            !date.isBefore(monday) && !date.isAfter(monday.plusDays(6))
        }
        CalendarViewMode.MONTH -> YearMonth.from(date) == YearMonth.from(selected)
        CalendarViewMode.DAY, CalendarViewMode.AGENDA -> date == selected
    }
/**
 * [bookings] narrowed to the ones whose LOCAL start date falls inside the
 * visible view (see [isDateInScheduleView]). A booking with an unparseable
 * `startDateTime` is dropped rather than guessed into the view -- the same
 * "never fabricate a day" rule `BusySlots.kt`'s placement functions follow.
 *
 * Callers pass whatever booking set is actually on screen (`filteredBookings`
 * in `ScheduleViewScreen.kt`, which already applies the service/kinfolk picker
 * filters the grid itself respects), never the operator's whole configured
 * `serviceRates`.
 */
fun bookingsInScheduleView(
    bookings: List<EnhancedBooking>,
    selected: LocalDate,
    viewMode: CalendarViewMode,
): List<EnhancedBooking> = bookings.filter { booking ->
    val date = runCatching {
        LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toLocalDate()
    }.getOrNull()
    date != null && isDateInScheduleView(date, selected, viewMode)
}
/**
 * Every distinct, non-blank service-type label present in [types],
 * alphabetically. Deliberately a raw extraction, not the final legend order or
 * membership -- mirrors the split web keeps between `distinctServiceTypes`
 * (`lib/scheduleFormat.ts`) and `sortServiceTypesByDuration`
 * (`lib/newBooking.ts`): MEMBERSHIP comes from whatever is actually on screen
 * (pass `bookingsInScheduleView(...).map { it.baseServiceTitle }`), ORDER comes
 * from a separate call to `sortServiceTypesByDuration` over
 * `BusinessSettings.serviceRates`/`serviceDurations`. A type present on screen
 * but never configured in `serviceRates` still comes out of here (and stays in
 * the legend) -- membership answers "what's on screen", not "what did the
 * operator configure".
 */
fun distinctServiceTypes(types: List<String>): List<String> =
    types.map { it.trim() }.filter { it.isNotEmpty() }.toSortedSet().toList()
