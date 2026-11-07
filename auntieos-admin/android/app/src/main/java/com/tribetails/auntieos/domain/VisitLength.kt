package com.tribetails.auntieos.domain

import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime

/**
 * #1581: the visit length a detail shows. The stored `serviceDurationMinutes`
 * when it is a real one, else the visit's own window (a 20:00 to 20:30 visit
 * stored with 0 is a 30-minute visit), else null. Same rule as the web's
 * `shownVisitLengthMinutes` (`lib/visitFacts.ts`).
 *
 * A window is read as two instants when both carry a zone, or as two wall
 * clocks when neither does (this app's zone-less convention); the span is the
 * same either way.
 */
fun shownVisitLengthMinutes(stored: Int, startTime: String, endTime: String): Int? {
    if (stored > 0) return stored
    val minutes = runCatching { Duration.between(Instant.parse(startTime.trim()), Instant.parse(endTime.trim())).toMinutes() }
        .recoverCatching { Duration.between(LocalDateTime.parse(startTime.trim()), LocalDateTime.parse(endTime.trim())).toMinutes() }
        .getOrNull()
    return minutes?.takeIf { it > 0 }?.toInt()
}
