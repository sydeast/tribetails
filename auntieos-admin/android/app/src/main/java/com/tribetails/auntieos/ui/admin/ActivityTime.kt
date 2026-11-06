package com.tribetails.auntieos.ui.admin
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
/** A log timestamp read on the business's calendar: its day key (`yyyy-MM-dd`) and compact clock ("9:34p"). */
internal data class ActivityWhen(val dayKey: String, val clock: String)
private val DATE_TIME_PREFIX = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}""")
/**
 * Reads a log timestamp in the BUSINESS zone (#1585), never the phone's and never
 * the UTC wall clock the string happens to carry. A stamp with a zone (`...Z`,
 * `+05:00`) is an instant; one without is already the business's wall clock, the
 * same reading the web client gives it. Null when the string has no readable date
 * and time, so the caller can say "Undated" rather than invent one.
 *
 * Mirrors `activityWhen` in `auntieos-admin/src/lib/activityDetail.ts`.
 */
internal fun activityWhen(timestamp: String, zone: ZoneId): ActivityWhen? {
    if (!DATE_TIME_PREFIX.containsMatchIn(timestamp)) return null
    val local = runCatching {
        runCatching { Instant.parse(timestamp).atZone(zone).toLocalDateTime() }
            .recoverCatching { OffsetDateTime.parse(timestamp).atZoneSameInstant(zone).toLocalDateTime() }
            .recoverCatching { LocalDateTime.parse(timestamp) }
            .getOrThrow()
    }.getOrNull() ?: return null
    val hour = local.hour
    val hour12 = if (hour % 12 == 0) 12 else hour % 12
    val clock = "$hour12:${local.minute.toString().padStart(2, '0')}${if (hour >= 12) "p" else "a"}"
    return ActivityWhen(dayKey = local.toLocalDate().toString(), clock = clock)
}
