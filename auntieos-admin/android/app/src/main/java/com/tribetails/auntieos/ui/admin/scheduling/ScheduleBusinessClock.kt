package com.tribetails.auntieos.ui.admin.scheduling

import androidx.compose.runtime.staticCompositionLocalOf
import com.tribetails.auntieos.data.model.businessZone
import com.tribetails.auntieos.data.repository.parseVisitInstant
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * #1158: the clock the operator's schedule surface reads, the BUSINESS's
 * (`business_settings.timeZone`, resolved by [businessZone]), never the phone's.
 *
 * Visit times on this client are the business's wall clock with no zone, and the
 * server reads them in that zone. "Today", "now", the note lock and the day the
 * Home dashboard loads are all read on the same clock, so a phone in another
 * zone sees the business's day and the business's hour.
 */
val LocalBusinessZone = staticCompositionLocalOf<ZoneId> { businessZone(null) }

/** Today on the business's calendar. [clock] is injectable so a test can pin the instant. */
internal fun businessToday(zone: ZoneId, clock: Clock = Clock.systemUTC()): LocalDate =
    LocalDate.now(clock.withZone(zone))

/** The business's wall clock right now. */
internal fun businessNow(zone: ZoneId, clock: Clock = Clock.systemUTC()): LocalDateTime =
    LocalDateTime.now(clock.withZone(zone))

/**
 * The business day's bounds as UTC instant strings (`[start, end)`), for a
 * `startTime` range query that has to return the visits on the business's today.
 */
internal fun businessDayBoundsIso(zone: ZoneId, clock: Clock = Clock.systemUTC()): Pair<String, String> {
    val today = businessToday(zone, clock)
    return today.atStartOfDay(zone).toInstant().toString() to today.plusDays(1).atStartOfDay(zone).toInstant().toString()
}

/**
 * A visit's start as epoch millis for the note lock: an instant (`Z`, offset)
 * as written, and a zone-less start as the business's wall clock. Null when
 * neither shape parses, which leaves the notes open (the server is the gate).
 */
internal fun visitStartMs(raw: String, zone: ZoneId): Long? = parseVisitInstant(raw, zone)?.toEpochMilli()

/** True while [now] (the business's wall clock) is inside the zone-less [start, end) window. */
internal fun isActiveAt(start: LocalDateTime?, end: LocalDateTime?, now: LocalDateTime): Boolean =
    start != null && end != null && !now.isBefore(start) && now.isBefore(end)
