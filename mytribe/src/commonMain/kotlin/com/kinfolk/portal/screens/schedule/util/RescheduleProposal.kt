package com.kinfolk.portal.screens.schedule.util

import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant

/** Longest reason the server will store (`requestBookingReschedule` Args). */
const val RESCHEDULE_REASON_MAX = 500

/**
 * The pure half of the reschedule ask (#469), kept out of the screen so the
 * arithmetic and the refusals have direct test coverage.
 */

/**
 * Epoch millis for [date] at [time], read in the household's own zone.
 *
 * Null when no date is picked or the time does not parse, which is the
 * screen's cue to say so rather than to send something guessed. The zone is
 * the caller's: a household typing 3pm means 3pm where it lives, and routing
 * this through UTC would move every proposal by the offset. Same reading the
 * web portal gives its `datetime-local` field.
 */
fun proposedStartMillis(
    date: LocalDate?,
    time: String,
    timeZone: TimeZone = TimeZone.currentSystemDefault(),
): Long? {
    if (date == null) return null
    val t = parseClock24(time) ?: return null
    return LocalDateTime(date.year, date.month, date.day, t.hour, t.minute)
        .toInstant(timeZone)
        .toEpochMilliseconds()
}

/**
 * A user-facing problem with the proposal, or null when it is worth sending.
 *
 * This is the browser-side check only. The server runs its own, and its
 * refusals (a time in the past, a time more than a year out, a second ask
 * while one is pending) are shown to the household verbatim when they arrive,
 * because it writes them for a household to read.
 */
fun rescheduleProblem(proposedStartMs: Long?, nowMs: Long): String? = when {
    proposedStartMs == null -> "Pick a date and time first."
    proposedStartMs <= nowMs -> "Pick a time in the future."
    else -> null
}

/**
 * "14:30" as a time, or null for anything that is not two numbers around a
 * colon. Deliberately strict: a half-typed field is a prompt to finish it, not
 * a time to guess at.
 */
fun parseClock24(text: String): LocalTime? {
    val parts = text.trim().split(":")
    if (parts.size != 2) return null
    val hour = parts[0].toIntOrNull() ?: return null
    val minute = parts[1].toIntOrNull() ?: return null
    if (hour !in 0..23 || minute !in 0..59) return null
    return LocalTime(hour, minute)
}
