package com.kinfolk.portal.util

import com.kinfolk.portal.portal.Booking
import kotlin.time.Instant
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * Month/day pair backing the little calendar tile on Schedule and Invoice
 * rows (the mockups' `.cal` block: colored month bar over a serif day).
 */
data class CalendarBadge(val month: String, val day: String)

private val MonthAbbrev = listOf(
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
)

/** Badge from an epoch-millis timestamp, or null when there is no date. */
fun calendarBadge(
    epochMillis: Long?,
    timeZone: TimeZone = TimeZone.currentSystemDefault(),
): CalendarBadge? {
    if (epochMillis == null) return null
    val ldt = Instant.fromEpochMilliseconds(epochMillis).toLocalDateTime(timeZone)
    return CalendarBadge(MonthAbbrev[ldt.month.ordinal], ldt.day.toString().padStart(2, '0'))
}

/**
 * Badge parsed from a human date label like "Sep 17, 2025" or "Jun 7"
 * (invoice due/paid dates arrive as display strings, not timestamps).
 * Returns null when the label has no recognizable month + day.
 */
fun calendarBadgeFromLabel(label: String?): CalendarBadge? {
    if (label.isNullOrBlank()) return null
    val tokens = label.split(' ', ',', '.').filter { it.isNotBlank() }
    val month = tokens.firstOrNull { t -> t.any { it.isLetter() } } ?: return null
    if (month.length < 3) return null
    val day = tokens.firstOrNull { t -> t.all { it.isDigit() } && t.length <= 2 } ?: return null
    return CalendarBadge(month.take(3).uppercase(), day.padStart(2, '0'))
}
/** Badge for a plain calendar date. */
fun calendarBadge(date: LocalDate): CalendarBadge =
    CalendarBadge(MonthAbbrev[date.month.ordinal], date.day.toString().padStart(2, '0'))
/**
 * Badge for a booked visit: its start, or for a night still waiting on its
 * start (#1098) the night the household asked for. Never midnight of a guess.
 */
fun bookingCalendarBadge(b: Booking, timeZone: TimeZone = TimeZone.currentSystemDefault()): CalendarBadge? =
    b.requestedNight()?.let { calendarBadge(it) } ?: calendarBadge(b.startTimeMs, timeZone)
