package com.tribetails.auntieos.web.screens.schedule

import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/** The `[2026-11-05T21:32:52Z]` stamp the office and field notes are written with. */
private val NOTE_STAMP = Regex("""\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)]""")

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * The visit notes as the operator reads them (#1592, web's `readableVisitNotes`
 * from #1676): each stored `[2026-11-05T21:32:52Z]` stamp shows as
 * `[Nov 5, 3:32 PM]` in [zone] (the business zone), with the year when it is
 * not this year. The STORED text is untouched: every client writes and parses
 * that format, so only the display changes.
 */
@OptIn(ExperimentalTime::class)
internal fun readableVisitNotes(notes: String, zone: TimeZone): String =
    readableVisitNotesAt(notes, zone, Clock.System.now())

/** [readableVisitNotes] with the clock passed in, for tests. */
@ExperimentalTime
internal fun readableVisitNotesAt(notes: String, zone: TimeZone, now: Instant): String {
    val thisYear = now.toLocalDateTime(zone).year
    return NOTE_STAMP.replace(notes) { m ->
        val at = runCatching { Instant.parse(m.groupValues[1]).toLocalDateTime(zone) }.getOrNull()
            ?: return@replace m.value
        val h12 = if (at.hour % 12 == 0) 12 else at.hour % 12
        val ampm = if (at.hour < 12) "AM" else "PM"
        val year = if (at.year == thisYear) "" else ", ${at.year}"
        "[${MONTHS[at.monthNumber - 1]} ${at.dayOfMonth}$year, $h12:${at.minute.toString().padStart(2, '0')} $ampm]"
    }
}
