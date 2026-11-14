package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.math.floor
import kotlin.time.ExperimentalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #2039: A CLOCK TAP THAT DOES NOT FIT THE BOOKING ASKS ONCE MORE.
 *
 * The console's twin of the web admin's `src/lib/clockStepWarning.ts`, with the
 * same two thresholds and the same sentences. On the walk a 45-minute visit
 * booked for 22:45 was clocked in at 21:58 and out a minute later, 43 minutes
 * before it was due to start, and nothing said anything was off. Since #2123 a
 * departure completes the visit and tells the household it has finished.
 *
 * A WARNING, NEVER A REFUSAL. This screen's clock buttons write at once; a tap
 * that does not fit the booking opens a confirm carrying the warning instead,
 * and confirming writes exactly what the tap would have. Nothing new is
 * written, so the stamp and the household notice keyed from it (#2238) are
 * unchanged. When it speaks, on the business clock:
 *   Arrived   more than [EARLY_ARRIVAL_WARNING_MINUTES] before the booked start;
 *   Departed  before the booked start, or with less than
 *             [SHORT_VISIT_WARNING_SHARE] of the booked length since clock-in.
 */
internal const val EARLY_ARRIVAL_WARNING_MINUTES = 30
internal const val SHORT_VISIT_WARNING_SHARE = 0.5

/** The confirm's title when a warning applies. */
internal const val CLOCK_STEP_WARNING_TITLE = "Check the time"

/** "1 minute", "43 minutes", "1 hour", "2 hours 5 minutes". */
internal fun spanWords(minutes: Double): String {
    val m = floor(maxOf(0.0, minutes)).toInt()
    if (m < 1) return "less than a minute"
    val hours = m / 60
    val rest = m % 60
    val minutePart = if (rest == 1) "1 minute" else "$rest minutes"
    if (hours == 0) return minutePart
    val hourPart = if (hours == 1) "1 hour" else "$hours hours"
    return if (rest == 0) hourPart else "$hourPart $minutePart"
}

/**
 * The warning for [action] on [session] at [nowMs], or null when the tap fits
 * the booking or nothing on the visit can say whether it does. Only Arrived
 * and Departed ever warn.
 */
@OptIn(ExperimentalTime::class)
internal fun clockStepWarning(
    action: AuntieTimeAction,
    session: KinCareSession,
    nowMs: Long,
    zone: TimeZone,
): String? {
    val start = businessInstantOf(session.startTime, zone)
    val startMs = start?.toEpochMilliseconds()
    val startClock = start?.toLocalDateTime(zone)?.let {
        "${it.hour.toString().padStart(2, '0')}:${it.minute.toString().padStart(2, '0')}"
    }.orEmpty()

    return when (action) {
        AuntieTimeAction.Arrived -> {
            if (startMs == null) return null
            val early = (startMs - nowMs) / 60_000.0
            if (early <= EARLY_ARRIVAL_WARNING_MINUTES) null
            else "This visit is booked for $startClock, ${spanWords(early)} from now."
        }
        AuntieTimeAction.Departed -> {
            if (startMs != null && nowMs < startMs) {
                return "This visit is booked to start at $startClock, ${spanWords((startMs - nowMs) / 60_000.0)} from now. " +
                    "Clocking out now ends it before it was due to begin."
            }
            val arrivedMs = businessInstantOf(session.arrivedAt, zone)?.toEpochMilliseconds() ?: return null
            val length = shownVisitLengthMinutes(session.serviceDurationMinutes, session.startTime, session.endTime)
                ?: return null
            if (length <= 0) return null
            val stayed = (nowMs - arrivedMs) / 60_000.0
            if (stayed >= length * SHORT_VISIT_WARNING_SHARE) null
            else "Only ${spanWords(stayed)} since clock-in. This visit is booked for ${spanWords(length.toDouble())}."
        }
        else -> null
    }
}
