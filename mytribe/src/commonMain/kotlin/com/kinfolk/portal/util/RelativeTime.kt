package com.kinfolk.portal.util

import com.kinfolk.portal.portal.Booking
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.plus
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime
import kotlin.math.abs

/**
 * Cross-platform relative time formatter.
 * Past:    "Just now", "5m ago", "3h ago", "2d ago", "Mar 14".
 * Future:  "Just now", "in 5m", "in 3h", "in 2d", "Mar 14".
 */
fun relativeTime(epochMillis: Long?, nowMillis: Long = Clock.System.now().toEpochMilliseconds()): String {
    if (epochMillis == null) return ""
    val deltaMs = nowMillis - epochMillis
    if (abs(deltaMs) < 60_000L) return "Just now"
    val isPast = deltaMs >= 0
    val absMs = abs(deltaMs)
    val minutes = absMs / 60_000L
    if (minutes < 60) return if (isPast) "${minutes}m ago" else "in ${minutes}m"
    val hours = minutes / 60L
    if (hours < 24) return if (isPast) "${hours}h ago" else "in ${hours}h"
    val days = hours / 24L
    if (days < 7) return if (isPast) "${days}d ago" else "in ${days}d"
    val ldt: LocalDateTime = Instant.fromEpochMilliseconds(epochMillis).toLocalDateTime(TimeZone.currentSystemDefault())
    val month = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")[ldt.month.ordinal]
    return "$month ${ldt.day}"
}

/**
 * "2:02 PM" in the CALLER's own local time zone, from a stored ISO-8601
 * instant string. Null on a missing or unparseable instant — never a
 * fabricated time (task-25, P4's fail-loud rule).
 *
 * Mirrors the web client's `weekdayTime`/`isoTime`
 * (mytribe/web/src/lib/portalFormat.ts) so the same visit-time concept reads
 * the same on both clients. This is the FIRST clock-time formatter on this
 * platform — `ScheduleScreen.kt`'s own visit-replay line renders the raw ISO
 * string with no formatting at all; that is a pre-existing rough edge in a
 * secondary panel, not a convention to extend into a new feature that the
 * brief requires to show local time.
 */
fun clockTime(iso: String?): String? {
    if (iso.isNullOrBlank()) return null
    val instant = try {
        Instant.parse(iso)
    } catch (_: Exception) {
        return null
    }
    val local = instant.toLocalDateTime(TimeZone.currentSystemDefault())
    val hour12 = when (val h = local.hour % 12) {
        0 -> 12
        else -> h
    }
    val minute = local.minute.toString().padStart(2, '0')
    val amPm = if (local.hour >= 12) "PM" else "AM"
    return "$hour12:$minute $amPm"
}

private val WEEKDAY_ABBREV = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val MONTH_ABBREV =
    listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * "Mon, 8:00 AM" in the caller's own time zone. Empty string on a null
 * timestamp, never a fabricated time.
 *
 * Mirrors `weekdayTime` in mytribe/web/src/lib/portalFormat.ts, so a proposed
 * visit time reads the same on both clients. [relativeTime] answers a
 * different question ("in 2d") and is wrong for a time a household is being
 * asked to check.
 */
fun weekdayTime(epochMillis: Long?, timeZone: TimeZone = TimeZone.currentSystemDefault()): String {
    if (epochMillis == null) return ""
    val local = Instant.fromEpochMilliseconds(epochMillis).toLocalDateTime(timeZone)
    val hour12 = when (val h = local.hour % 12) {
        0 -> 12
        else -> h
    }
    val minute = local.minute.toString().padStart(2, '0')
    val amPm = if (local.hour >= 12) "PM" else "AM"
    // kotlinx-datetime counts the ISO week from Monday; the web list counts
    // from Sunday. Both name the same day, and WEEKDAY_ABBREV is ordered to
    // match the ordinal it is indexed with.
    val weekday = WEEKDAY_ABBREV[local.dayOfWeek.ordinal]
    return "$weekday, $hour12:$minute $amPm"
}

/**
 * "Today" / "Yesterday" / "3 days ago", falling back to "Mar 14" past a week.
 * Empty string on a null timestamp.
 *
 * Mirrors `relativeDay` in mytribe/web/src/lib/portalFormat.ts, which is what
 * the web Gallery captions a photo with when its KinTale carries no title.
 * Unlike [relativeTime] this counts whole calendar days, so a photo sent this
 * morning reads "Today" rather than "7h ago".
 */
fun relativeDay(
    epochMillis: Long?,
    nowMillis: Long = Clock.System.now().toEpochMilliseconds(),
    timeZone: TimeZone = TimeZone.currentSystemDefault(),
): String {
    if (epochMillis == null) return ""
    val then = Instant.fromEpochMilliseconds(epochMillis).toLocalDateTime(timeZone).date
    val today = Instant.fromEpochMilliseconds(nowMillis).toLocalDateTime(timeZone).date
    val days = today.toEpochDays() - then.toEpochDays()
    return when {
        days <= 0L -> "Today"
        days == 1L -> "Yesterday"
        days < 7L -> "$days days ago"
        else -> "${MONTH_ABBREV[then.month.ordinal]} ${then.day}"
    }
}
/** #1098: what a night-only visit says in place of a clock time until the Auntie sets one. */
const val AUNTIE_SETS_START_TIME = "Start time set by your Auntie"
private val NightWeekdays = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
/**
 * #1098: the night a booked visit is waiting on, as a calendar date, or null
 * when it has a start or carries no readable night. Parsed as a plain date:
 * never through an instant, which would land on the day before west of UTC.
 */
fun Booking.requestedNight(): LocalDate? =
    if (!startTimePending) null else requestedDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
/**
 * When a booked visit happens, for a list row: [relativeTime] of its start, or
 * for a night still waiting on its start (#1098) "Fri night · Start time set
 * by your Auntie". Mirrors `visitWhenLine` in mytribe/web/src/lib/portalFormat.ts.
 */
fun bookingWhenLabel(b: Booking, nowMillis: Long = Clock.System.now().toEpochMilliseconds()): String {
    if (!b.startTimePending) return relativeTime(b.startTimeMs, nowMillis)
    val night = b.requestedNight() ?: return AUNTIE_SETS_START_TIME
    return "${NightWeekdays[night.dayOfWeek.ordinal]} night · $AUNTIE_SETS_START_TIME"
}
/**
 * The instant a booked visit sorts at: its start, or for a night still waiting
 * on its start (#1098) the last millisecond of that night's day, or null.
 */
fun bookingSortMs(b: Booking, tz: TimeZone = TimeZone.currentSystemDefault()): Long? {
    if (!b.startTimePending) return b.startTimeMs
    val night = b.requestedNight() ?: return b.startTimeMs
    return LocalDateTime(night.plus(1, DateTimeUnit.DAY), LocalTime(0, 0)).toInstant(tz).toEpochMilliseconds() - 1
}
