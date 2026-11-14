package com.tribetails.auntieos.domain

import java.time.ZoneId
import kotlin.math.floor

/**
 * #2039: A CLOCK TAP THAT DOES NOT FIT THE BOOKING ASKS ONCE MORE.
 *
 * The Kotlin twin of the web's `src/lib/clockStepWarning.ts`: the same two
 * thresholds and the same sentences. On the walk a 45-minute visit booked for
 * 22:45 was clocked in at 21:58 and out a minute later, 43 minutes before it
 * was due to start, with nothing to say anything was off. Since #2123 a
 * departure completes the visit and tells the household it has finished.
 *
 * A WARNING, NEVER A REFUSAL. The Auntie at the door is the one who knows. This
 * app's Arrived and Departed taps write straight away; when this returns a
 * sentence they ask first ("Check the time"), and a confirm writes exactly what
 * the tap would have. Nothing new is stored, so the step, its stamp and the
 * household notice keyed from that stamp (#2238) are unchanged.
 *
 *   Arrived   more than [EARLY_ARRIVAL_WARNING_MINUTES] before the booked start;
 *   Departed  before the booked start, or with less than
 *             [SHORT_VISIT_WARNING_SHARE] of the booked length since clock-in.
 */
const val EARLY_ARRIVAL_WARNING_MINUTES = 30
const val SHORT_VISIT_WARNING_SHARE = 0.5

/** The dialog title the warning is asked under, on every client. */
const val CLOCK_STEP_WARNING_TITLE = "Check the time"

enum class ClockStep { ARRIVED, DEPARTED }

/** "1 minute", "43 minutes", "1 hour", "2 hours 5 minutes". */
fun spanWords(minutes: Double): String {
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
 * The warning for this clock step, or null when the tap fits the booking (or
 * nothing on the visit can say whether it does).
 */
fun clockStepWarning(
    step: ClockStep,
    startTime: String?,
    endTime: String?,
    serviceDurationMinutes: Int,
    arrivedAt: String?,
    nowMs: Long,
    zone: ZoneId,
): String? {
    val startMs = storedBusinessInstant(startTime, zone)?.toEpochMilli()
    val startClock = storedBusinessClock(startTime, zone)
    return when (step) {
        ClockStep.ARRIVED -> {
            if (startMs == null) return null
            val early = (startMs - nowMs) / 60_000.0
            if (early <= EARLY_ARRIVAL_WARNING_MINUTES) null
            else "This visit is booked for $startClock, ${spanWords(early)} from now."
        }
        ClockStep.DEPARTED -> {
            if (startMs != null && nowMs < startMs) {
                return "This visit is booked to start at $startClock, ${spanWords((startMs - nowMs) / 60_000.0)} from now. " +
                    "Clocking out now ends it before it was due to begin."
            }
            val arrivedMs = storedBusinessInstant(arrivedAt, zone)?.toEpochMilli() ?: return null
            val length = bookedLengthMinutes(serviceDurationMinutes, startTime, endTime, zone) ?: return null
            val stayed = (nowMs - arrivedMs) / 60_000.0
            if (stayed >= length * SHORT_VISIT_WARNING_SHARE) null
            else "Only ${spanWords(stayed)} since clock-in. This visit is booked for ${spanWords(length.toDouble())}."
        }
    }
}

/** The stored length when it is real, else the window's span, else null. */
private fun bookedLengthMinutes(stored: Int, startTime: String?, endTime: String?, zone: ZoneId): Int? {
    if (stored > 0) return stored
    val start = storedBusinessInstant(startTime, zone) ?: return null
    val end = storedBusinessInstant(endTime, zone) ?: return null
    val minutes = ((end.toEpochMilli() - start.toEpochMilli()) / 60_000L).toInt()
    return minutes.takeIf { it > 0 }
}
