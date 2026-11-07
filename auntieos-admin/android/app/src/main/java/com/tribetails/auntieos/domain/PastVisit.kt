package com.tribetails.auntieos.domain

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * #1574: whether a visit's window is ahead, over, or under way, judged on the
 * business clock before anything is sent. The server's
 * `mytribe/functions/src/lib/pastVisit.ts` is the enforcement; this is the same
 * split, so the form says which case it is instead of the operator finding out
 * from a refusal. `PastVisitTest` reads the server file to keep the sentences
 * identical to the ones it sends.
 *
 * Operator ruling, 2026-11-05 docket: a visit created with a past date is
 * allowed only as already Completed, never Scheduled. Moving an existing visit
 * into the past stays blocked.
 *
 * Wall clocks throughout, because that is what this app's Schedule types and
 * sends (`buildRescheduleTimes` emits a zone-less `yyyy-MM-dd'T'HH:mm:ss`), and
 * the server reads a zone-less time on the same business clock.
 */
enum class VisitWindowTiming { AHEAD, ENDED, UNDERWAY }

const val VISIT_UNDERWAY_MESSAGE =
    "That visit would already be under way. Pick a start still ahead to schedule it, or record it as completed once it has ended."
const val RESCHEDULE_IN_PAST_MESSAGE =
    "That time has already passed. A visit can only be moved to a time still ahead."
const val RECORD_COMPLETED_HINT =
    "This time has already passed, so the visit is recorded as completed. The household is not notified."

/**
 * Same rule as the server's `classifyVisitWindow`: a start exactly at now is
 * ahead, an end exactly at now has ended, and an end not after the start reads
 * as the start, so a zero-length window is never under way.
 */
fun classifyVisitWindow(start: LocalDateTime, end: LocalDateTime?, now: LocalDateTime): VisitWindowTiming {
    if (!start.isBefore(now)) return VisitWindowTiming.AHEAD
    val effectiveEnd = end?.takeIf { it.isAfter(start) } ?: start
    return if (!effectiveEnd.isAfter(now)) VisitWindowTiming.ENDED else VisitWindowTiming.UNDERWAY
}

/** New visit: a date and two clock times typed on the business clock. */
fun newVisitTiming(date: LocalDate, start: LocalTime, end: LocalTime, now: LocalDateTime): VisitWindowTiming =
    classifyVisitWindow(LocalDateTime.of(date, start), LocalDateTime.of(date, end), now)

/**
 * The reschedule pre-check for a zone-less wall-clock start. Returns the
 * sentence to show, or null when the move may be sent; an unreadable start is
 * left to the caller's own validation.
 */
fun rescheduleIntoPastRefusal(startWallClock: String, now: LocalDateTime): String? {
    val start = runCatching { LocalDateTime.parse(startWallClock, DateTimeFormatter.ISO_LOCAL_DATE_TIME) }.getOrNull()
        ?: return null
    return if (start.isBefore(now)) RESCHEDULE_IN_PAST_MESSAGE else null
}

/** A wall clock on [zone] as the UTC-suffixed ISO the web's New visit sends, so a recorded visit sorts like every other row. */
fun wallClockToUtcIso(date: LocalDate, time: LocalTime, zone: ZoneId): String =
    LocalDateTime.of(date, time).atZone(zone).toInstant().toString()
