package com.tribetails.auntieos.domain

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

/** The `[2026-11-05T21:32:52Z]` stamp the office and field notes are written with. */
private val NOTE_STAMP = Regex("""\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)]""")

private val SAME_YEAR = DateTimeFormatter.ofPattern("MMM d, h:mm a", Locale.US)
private val OTHER_YEAR = DateTimeFormatter.ofPattern("MMM d, yyyy, h:mm a", Locale.US)

/**
 * The visit notes as the operator reads them (#1592, web's `readableVisitNotes`
 * from #1676): each stored `[2026-11-05T21:32:52Z]` stamp shows as
 * `[Nov 5, 3:32 PM]` in [zone] (the business zone), with the year when it is
 * not this year. The STORED text is untouched: every client writes and parses
 * that format, so only the display changes.
 */
fun readableVisitNotes(notes: String, zone: ZoneId, now: Instant = Instant.now()): String {
    val thisYear = now.atZone(zone).year
    return NOTE_STAMP.replace(notes) { m ->
        val at = try {
            Instant.parse(m.groupValues[1]).atZone(zone)
        } catch (_: DateTimeParseException) {
            return@replace m.value
        }
        val fmt = if (at.year == thisYear) SAME_YEAR else OTHER_YEAR
        "[${fmt.format(at)}]"
    }
}
