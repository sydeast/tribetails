package com.tribetails.auntieos.web.screens.sessions

import androidx.compose.runtime.staticCompositionLocalOf
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import com.tribetails.auntieos.web.screens.booking.NewBookingMath
import com.tribetails.auntieos.web.screens.schedule.businessDateTimeOf
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atStartOfDayIn
import kotlinx.datetime.isoDayNumber
import kotlinx.datetime.minus
import kotlinx.datetime.plus
import kotlinx.datetime.toInstant

/**
 * ISSUE #2036: Auntie Time's days on the BUSINESS's calendar, and the Archive.
 * The console's twin of the web admin's `src/lib/sessionArchive.ts` and the
 * Android app's `AuntieTimeArchive.kt`.
 *
 * A stored time is an instant (`...Z`) or a zone-less business wall clock. This
 * screen used to take the first ten characters of either as the day, which for
 * an instant is the UTC day, and read "today" off the UTC clock too: a 23:30
 * visit in America/Chicago was filed under tomorrow. Every day here now goes
 * through [businessDayOf] in the zone `business_settings.timeZone` names.
 *
 * The board shows what is in flight, overdue, coming up, or wrapped since
 * yesterday. Older visits had no list on the console; the Archive is that list,
 * over a FROM and TO that are whole business days.
 */

/** The zone the Auntie Time cards print their day and clock in. */
internal val LocalAuntieTimeZone = staticCompositionLocalOf<TimeZone> { NewBookingMath.businessTimeZone(null) }

private val LEADING_DAY = Regex("""^\d{4}-\d{2}-\d{2}""")

/**
 * The business day ("YYYY-MM-DD") a stored time falls on, or "" when it has
 * none. A value that is only a date, or whose clock does not parse, keeps its
 * own leading day rather than being dropped.
 */
internal fun businessDayOf(iso: String, zone: TimeZone): String {
    businessDateTimeOf(iso.trim(), zone)?.let { return it.date.toString() }
    return LEADING_DAY.find(iso.trim())?.value.orEmpty()
}

/** A stored time as an instant: an instant as written, a zone-less value as the business's wall clock. */
@OptIn(ExperimentalTime::class)
internal fun businessInstantOf(iso: String, zone: TimeZone): Instant? {
    val text = iso.trim()
    if (text.isEmpty()) return null
    runCatchingCancellable { Instant.parse(text) }.getOrNull()?.let { return it }
    return runCatchingCancellable { LocalDateTime.parse(text).toInstant(zone) }.getOrNull()
}

/** How many days the Archive's opening range covers. */
internal const val ARCHIVE_DEFAULT_SPAN_DAYS = 30

/** How far back Recent reaches on the board: wrapped today or yesterday. */
internal const val RECENT_WINDOW_DAYS = 1

/** An inclusive range of business days. */
internal data class ArchiveRange(val from: LocalDate, val to: LocalDate)

/**
 * The range the Archive opens on: the 30 days ending the day before Recent
 * begins, so no wrapped visit sits between the two lists. [today] is the
 * business's.
 */
internal fun archiveDefaultRange(today: LocalDate): ArchiveRange {
    val to = today.minus(RECENT_WINDOW_DAYS + 1, DateTimeUnit.DAY)
    return ArchiveRange(from = to.minus(ARCHIVE_DEFAULT_SPAN_DAYS - 1, DateTimeUnit.DAY), to = to)
}

/** Setting one box past the other moves the other to the same day, so the range is never inside out. */
internal fun ArchiveRange.withFrom(day: LocalDate): ArchiveRange =
    ArchiveRange(from = day, to = if (day > to) day else to)

internal fun ArchiveRange.withTo(day: LocalDate): ArchiveRange =
    ArchiveRange(from = if (day < from) day else from, to = day)

/**
 * Whether a stored `startTime` falls on one of the range's business days: from
 * the first moment of the FROM day up to the first moment of the day after TO.
 * The end is found by date, never by adding 24 hours, so the 23 and 25 hour
 * days of a clock change are each one whole day.
 */
@OptIn(ExperimentalTime::class)
internal fun isInArchiveRange(startTime: String, range: ArchiveRange, zone: TimeZone): Boolean {
    val at = businessInstantOf(startTime, zone)
    if (at == null) {
        val day = businessDayOf(startTime, zone)
        return day.isNotEmpty() && day >= range.from.toString() && day <= range.to.toString()
    }
    val start = range.from.atStartOfDayIn(zone)
    val end = range.to.plus(1, DateTimeUnit.DAY).atStartOfDayIn(zone)
    return at >= start && at < end
}

/** One business day of the Archive, its visits in time order. */
internal data class ArchiveDay(val day: String, val sessions: List<KinCareSession>)

private val BOOKING_QUEUE_STATUSES = setOf("DRAFT", "PENDING", "REJECTED")

/**
 * The Archive's list: every visit that starts in [range], under the business
 * day it starts on, days and visits ascending. DRAFT, PENDING and REJECTED are
 * left out as they are on the board: the Bookings screen owns that queue.
 */
@OptIn(ExperimentalTime::class)
internal fun archiveDays(
    sessions: List<KinCareSession>,
    range: ArchiveRange,
    zone: TimeZone,
): List<ArchiveDay> =
    sessions
        .filter { it.status.trim().uppercase() !in BOOKING_QUEUE_STATUSES && isInArchiveRange(it.startTime, range, zone) }
        .groupBy { businessDayOf(it.startTime, zone) }
        .entries
        .sortedBy { it.key }
        .map { (day, rows) ->
            ArchiveDay(
                day = day,
                sessions = rows.sortedBy { businessInstantOf(it.startTime, zone)?.toEpochMilliseconds() ?: 0L },
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
    val date = runCatchingCancellable { LocalDate.parse(day) }.getOrNull() ?: return day
    return when (date) {
        today -> "Today"
        today.minus(1, DateTimeUnit.DAY) -> "Yesterday"
        today.plus(1, DateTimeUnit.DAY) -> "Tomorrow"
        else -> {
            val weekday = ARCHIVE_WEEKDAYS[date.dayOfWeek.isoDayNumber - 1]
            val month = ARCHIVE_MONTHS[date.monthNumber - 1]
            val year = if (date.year == today.year) "" else ", ${date.year}"
            "$weekday, $month ${date.dayOfMonth}$year"
        }
    }
}

/** A date box's own text: "Nov 11, 2026". */
internal fun archiveBoxLabel(day: LocalDate): String =
    "${ARCHIVE_MONTHS[day.monthNumber - 1]} ${day.dayOfMonth}, ${day.year}"

/** "Nov 11 · 23:30" on the business's clock, or the stored text when it does not read. */
internal fun businessShortDateTime(iso: String, zone: TimeZone): String {
    val at = businessDateTimeOf(iso.trim(), zone) ?: return iso
    return "${ARCHIVE_MONTHS[at.monthNumber - 1]} ${at.dayOfMonth} · ${clockOf(at)}"
}

/** "23:30" on the business's clock, or the stored text when it does not read. */
internal fun businessShortTime(iso: String, zone: TimeZone): String =
    businessDateTimeOf(iso.trim(), zone)?.let(::clockOf) ?: iso

private fun clockOf(at: LocalDateTime): String =
    "${at.hour.toString().padStart(2, '0')}:${at.minute.toString().padStart(2, '0')}"
