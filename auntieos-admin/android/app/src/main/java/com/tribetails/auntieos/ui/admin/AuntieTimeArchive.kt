package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.parseVisitInstant
import java.time.LocalDate
import java.time.ZoneId

/**
 * ISSUE #2036: Auntie Time's Archive, the pure half. The Kotlin twin of the web
 * admin's `src/lib/sessionArchive.ts`.
 *
 * The board shows what is in flight, overdue, coming up, or wrapped today or
 * yesterday. Everything older had no list on this app at all: a visit completed
 * ten days ago could not be opened from Auntie Time. The Archive is that list,
 * over a FROM and TO the operator picks.
 *
 * FROM and TO are whole days on the BUSINESS's calendar. A stored start is an
 * instant or a zone-less business wall clock ([parseVisitInstant] reads both),
 * and it is in range from the first moment of the FROM day up to the first
 * moment of the day after TO, in the business zone. The end is found by date,
 * never by adding 24 hours, so the 23 and 25 hour days of a clock change are
 * each one whole day.
 */

/** How many days the Archive's opening range covers. */
const val ARCHIVE_DEFAULT_SPAN_DAYS = 30

/** An inclusive range of business days. */
internal data class ArchiveRange(val from: LocalDate, val to: LocalDate)

/**
 * The range the Archive opens on: the 30 days ending the day before Recent
 * begins. Recent holds what wrapped today or yesterday ([RECENT_WINDOW_DAYS]),
 * so no wrapped visit sits between the two lists. [today] is the business's.
 */
internal fun archiveDefaultRange(today: LocalDate): ArchiveRange {
    val to = today.minusDays((RECENT_WINDOW_DAYS + 1).toLong())
    return ArchiveRange(from = to.minusDays((ARCHIVE_DEFAULT_SPAN_DAYS - 1).toLong()), to = to)
}

/**
 * The range after the operator sets one box. A FROM later than TO (or a TO
 * earlier than FROM) moves the other box to the same day, so the range is never
 * inside out and never silently empty.
 */
internal fun ArchiveRange.withFrom(day: LocalDate): ArchiveRange =
    ArchiveRange(from = day, to = if (day.isAfter(to)) day else to)

internal fun ArchiveRange.withTo(day: LocalDate): ArchiveRange =
    ArchiveRange(from = if (day.isBefore(from)) day else from, to = day)

/** Whether a stored `startTime` falls on one of the range's business days. */
internal fun isInArchiveRange(startTime: String, range: ArchiveRange, zone: ZoneId): Boolean {
    val at = parseVisitInstant(startTime.trim(), zone)
    if (at == null) {
        // A start with no readable clock keeps its own leading day.
        val day = businessDayOf(startTime, zone)
        return day.isNotEmpty() && day >= range.from.toString() && day <= range.to.toString()
    }
    val start = range.from.atStartOfDay(zone).toInstant()
    val end = range.to.plusDays(1).atStartOfDay(zone).toInstant()
    return !at.isBefore(start) && at.isBefore(end)
}

/** One business day of the Archive, its visits in time order. */
internal data class ArchiveDay(val day: String, val sessions: List<KinCareSession>)

/**
 * The Archive's list: every visit that starts in [range], under the business
 * day it starts on, days and visits ascending. DRAFT, PENDING and REJECTED are
 * left out here as they are on the board, because the Bookings screen owns
 * that queue and a request that was never approved is not a visit.
 */
internal fun archiveDays(
    sessions: List<KinCareSession>,
    range: ArchiveRange,
    zone: ZoneId,
): List<ArchiveDay> =
    sessions
        .filter { !isBookingQueueStatus(it.status) && isInArchiveRange(it.startTime, range, zone) }
        .groupBy { businessDayOf(it.startTime, zone) }
        .toSortedMap()
        .map { (day, rows) ->
            ArchiveDay(
                day = day,
                sessions = rows.sortedBy { parseVisitInstant(it.startTime.trim(), zone)?.toEpochMilli() ?: 0L },
            )
        }

private val ARCHIVE_WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val ARCHIVE_MONTHS =
    listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * A day heading, word for word the web Archive's: "Today", "Yesterday",
 * "Tomorrow", else "Thu, Jul 16", with the year once it is not [today]'s.
 */
internal fun archiveDayLabel(day: String, today: LocalDate): String {
    val date = runCatching { LocalDate.parse(day) }.getOrNull() ?: return day
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        today.plusDays(1) -> "Tomorrow"
        else -> {
            val weekday = ARCHIVE_WEEKDAYS[date.dayOfWeek.value - 1]
            val month = ARCHIVE_MONTHS[date.monthValue - 1]
            val year = if (date.year == today.year) "" else ", ${date.year}"
            "$weekday, $month ${date.dayOfMonth}$year"
        }
    }
}

/** A date box's own text: "Nov 11, 2026". */
internal fun archiveBoxLabel(day: LocalDate): String =
    "${ARCHIVE_MONTHS[day.monthValue - 1]} ${day.dayOfMonth}, ${day.year}"
