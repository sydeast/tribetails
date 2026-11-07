package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant

/**
 * #1581: the visit length a detail shows. The stored `serviceDurationMinutes`
 * when it is a real one, else the visit's own window (a 20:00 to 20:30 visit
 * stored with 0 is a 30-minute visit), else null. Same rule as the web's
 * `shownVisitLengthMinutes` (`lib/visitFacts.ts`) and Android's
 * `domain/VisitLength.kt`.
 *
 * Two instants when both carry a zone, else two wall clocks read on one zone
 * (UTC here: only the span matters, and both ends share it).
 */
@OptIn(ExperimentalTime::class)
fun shownVisitLengthMinutes(stored: Int, startTime: String, endTime: String): Int? {
    if (stored > 0) return stored
    fun ms(iso: String): Long? {
        val t = iso.trim()
        if (t.isEmpty()) return null
        runCatchingCancellable { return Instant.parse(t).toEpochMilliseconds() }
        return runCatchingCancellable { LocalDateTime.parse(t).toInstant(TimeZone.UTC).toEpochMilliseconds() }.getOrNull()
    }
    val s = ms(startTime) ?: return null
    val e = ms(endTime) ?: return null
    val minutes = (e - s) / 60_000L
    return if (minutes > 0) minutes.toInt() else null
}
