package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant

/**
 * #1574: whether a visit's window is ahead, over, or under way, judged before
 * anything is sent. The server's `mytribe/functions/src/lib/pastVisit.ts` is the
 * enforcement; this is the same split, so the form says which case it is
 * instead of the operator finding out from a refusal. `PastVisitTest` reads the
 * server file to keep the sentences identical to the ones it sends.
 *
 * Operator ruling, 2026-11-05 docket: a visit created with a past date is
 * allowed only as already Completed, never Scheduled. Moving an existing visit
 * into the past stays blocked.
 *
 * This console types and sends zone-less wall clocks on the business clock
 * (`buildRescheduleTimes`), and the server reads a zone-less time on that same
 * clock, so [zone] here is the Schedule's business zone.
 */
enum class VisitWindowTiming { AHEAD, ENDED, UNDERWAY }

const val VISIT_UNDERWAY_MESSAGE =
    "That visit would already be under way. Pick a start still ahead to schedule it, or record it as completed once it has ended."
const val RESCHEDULE_IN_PAST_MESSAGE =
    "That time has already passed. A visit can only be moved to a time still ahead."
const val RECORD_COMPLETED_HINT =
    "This time has already passed, so the visit is recorded as completed. The household is not notified."

/** An instant, or a zone-less wall clock read on [zone]. Null when it is neither. */
@OptIn(ExperimentalTime::class)
internal fun visitTimeMs(iso: String, zone: TimeZone): Long? {
    if (iso.isBlank()) return null
    runCatchingCancellable { return Instant.parse(iso).toEpochMilliseconds() }
    return runCatchingCancellable { LocalDateTime.parse(iso).toInstant(zone).toEpochMilliseconds() }.getOrNull()
}

/**
 * Same rule as the server's `classifyVisitWindow`: a start exactly at now is
 * ahead, an end exactly at now has ended, and an end not after the start reads
 * as the start, so a zero-length window is never under way.
 */
fun classifyVisitWindow(startMs: Long, endMs: Long?, nowMs: Long): VisitWindowTiming {
    if (startMs >= nowMs) return VisitWindowTiming.AHEAD
    val end = endMs?.takeIf { it > startMs } ?: startMs
    return if (end <= nowMs) VisitWindowTiming.ENDED else VisitWindowTiming.UNDERWAY
}

/** The `(start, end)` pair a create sends, classified. Null when the start cannot be read. */
fun timingOf(times: Pair<String, String>, zone: TimeZone, nowMs: Long): VisitWindowTiming? {
    val start = visitTimeMs(times.first, zone) ?: return null
    return classifyVisitWindow(start, visitTimeMs(times.second, zone), nowMs)
}

/**
 * The reschedule pre-check. Returns the sentence to show, or null when the move
 * may be sent; an unreadable start is left to the caller's own validation.
 */
fun rescheduleIntoPastRefusal(startIso: String, zone: TimeZone, nowMs: Long): String? {
    val start = visitTimeMs(startIso, zone) ?: return null
    return if (start < nowMs) RESCHEDULE_IN_PAST_MESSAGE else null
}
