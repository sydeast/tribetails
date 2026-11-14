package com.tribetails.auntieos.domain

import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException

/**
 * #2095: A STORED VISIT TIME ON THE BUSINESS CLOCK.
 *
 * A visit's start (and its end, arrival, departure and completion stamps) is
 * stored two ways: a UTC instant (`2026-11-12T05:30:00.000Z`) or the business's
 * wall clock with no zone (`2026-11-11T23:30:00`). Several screens printed
 * characters 1 to 10 or 12 to 16 of whichever was stored, which for an instant
 * is the UTC day and hour: an 11:30 PM Chicago visit read "Nov 12 · 05:30".
 *
 * An instant is converted into the business [zone]; a zone-less value already is
 * that clock and is kept. Null when the text is neither.
 */
fun storedBusinessLocal(raw: String?, zone: ZoneId): LocalDateTime? {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty()) return null
    val instant = try {
        Instant.parse(text)
    } catch (_: DateTimeParseException) {
        null
    } ?: try {
        java.time.OffsetDateTime.parse(text).toInstant()
    } catch (_: DateTimeParseException) {
        null
    }
    if (instant != null) return instant.atZone(zone).toLocalDateTime()
    return try {
        LocalDateTime.parse(text)
    } catch (_: DateTimeParseException) {
        null
    }
}

/** The stored time as an instant, a zone-less value read on the business clock. */
fun storedBusinessInstant(raw: String?, zone: ZoneId): Instant? =
    storedBusinessLocal(raw, zone)?.atZone(zone)?.toInstant()

private val LEADING_DAY = Regex("""^\d{4}-\d{2}-\d{2}""")

/**
 * The business day ("YYYY-MM-DD") of a stored time. A value that is only a
 * date keeps that date; "" when there is none.
 */
fun storedBusinessDay(raw: String?, zone: ZoneId): String {
    storedBusinessLocal(raw, zone)?.let { return it.toLocalDate().toString() }
    return LEADING_DAY.find(raw?.trim().orEmpty())?.value.orEmpty()
}

/** "HH:mm" on the business clock, or "" when the stored value has no readable time. */
fun storedBusinessClock(raw: String?, zone: ZoneId): String {
    val at = storedBusinessLocal(raw, zone) ?: return ""
    return "${at.hour.toString().padStart(2, '0')}:${at.minute.toString().padStart(2, '0')}"
}
