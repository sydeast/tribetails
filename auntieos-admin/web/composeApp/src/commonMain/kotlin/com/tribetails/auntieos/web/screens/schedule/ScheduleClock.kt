package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import com.tribetails.auntieos.web.screens.booking.NewBookingMath
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #1158: the clock the Schedule screen is drawn on, the BUSINESS's
 * (`business_settings.timeZone`), never the machine's.
 *
 * The grid rows, the day columns, "today", the now line, the detail sheet's
 * reschedule prefill and its note lock all read this one zone. A drop writes a
 * zone-less wall clock (`rescheduleArgsForDrop`), which the server reads in the
 * same zone, so a visit dropped on the 15:00 row lands at 15:00 where the
 * business is, whatever zone the console's machine is in. An unset or unusable
 * zone is America/Chicago, the server's own default (#1109).
 */
internal data class ScheduleClock(
    val zone: TimeZone,
    val today: LocalDate,
    val nowMinutes: Int,
)

@OptIn(ExperimentalTime::class)
internal fun scheduleClockOf(storedTimeZone: String?, now: Instant): ScheduleClock {
    val zone = NewBookingMath.businessTimeZone(storedTimeZone)
    val t = now.toLocalDateTime(zone)
    return ScheduleClock(zone = zone, today = t.date, nowMinutes = t.hour * 60 + t.minute)
}

/**
 * A stored visit time on the business's clock: an instant (`Z` or an offset) is
 * converted into [zone], and a zone-less value is already that wall clock.
 * Null when neither shape parses.
 */
@OptIn(ExperimentalTime::class)
internal fun businessDateTimeOf(iso: String, zone: TimeZone): LocalDateTime? {
    if (iso.isBlank()) return null
    runCatchingCancellable { Instant.parse(iso).toLocalDateTime(zone) }.getOrNull()?.let { return it }
    return runCatchingCancellable { LocalDateTime.parse(iso) }.getOrNull()
}

/** The reschedule form's date prefill (`YYYY-MM-DD`) on the business's clock, or "". */
internal fun businessDatePart(iso: String, zone: TimeZone): String =
    businessDateTimeOf(iso, zone)?.date?.toString() ?: isoDatePart(iso)

/** The reschedule form's time prefill (`HH:mm`) on the business's clock, or "". */
internal fun businessTimePart(iso: String, zone: TimeZone): String =
    businessDateTimeOf(iso, zone)?.let { "${it.hour.toString().padStart(2, '0')}:${it.minute.toString().padStart(2, '0')}" }
        ?: isoTimePart(iso)
