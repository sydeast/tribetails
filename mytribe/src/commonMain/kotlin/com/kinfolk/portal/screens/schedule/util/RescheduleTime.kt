package com.kinfolk.portal.screens.schedule.util
import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.BookingPolicy
import com.kinfolk.portal.portal.TimeBlock
import com.kinfolk.portal.portal.WeekdayHours
import com.kinfolk.portal.screens.schedule.bookingDateKey
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
/**
 * #1284: the pure half of the reschedule form, in lockstep with
 * `mytribe/web/src/lib/rescheduleTime.ts`.
 *
 * The form reuses the booking wizard's month grid, policy and closures. What it
 * adds is the arithmetic those cannot do for one proposed time: turning a picked
 * day plus a clock time or a block into an instant ON THE BUSINESS CLOCK, and
 * saying why a combination will not work before the server does. The server
 * (`rescheduleTimeRules.ts`) is the authority; this only keeps a doomed request
 * from being sent.
 */
/** The ruled default zone (#1109), used only when an older server returns none. */
const val FALLBACK_TIME_ZONE = "America/Chicago"
/** How far ahead of now a block that is already open is carried, matching `anchorOpenBlockVisit`. */
const val OPEN_BLOCK_LEAD_MINUTES = 15
private const val OPEN_BLOCK_STEP_MS = 5L * 60_000L
private val WEEKDAY_NAMES = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
/** 0 = Sunday, the numbering `getBusinessClosures` uses for `weekday`. */
fun LocalDate.sundayZeroWeekday(): Int = dayOfWeek.ordinal.let { (it + 1) % 7 }
/**
 * The instant the wall clock in [timeZoneId] reads [hhmm] on [day]. `24:00` is
 * the next midnight. Null when the time does not parse or the zone is unknown.
 */
fun zonedWallClockToMs(day: LocalDate, hhmm: String, timeZoneId: String): Long? {
    val zone = runCatching { TimeZone.of(timeZoneId) }.getOrNull() ?: return null
    if (hhmm.trim() == "24:00") {
        return LocalDateTime(day.year, day.month, day.day, 0, 0)
            .toInstant(zone).toEpochMilliseconds() + 24L * 60L * 60L * 1000L
    }
    val t = parseClock24(hhmm) ?: return null
    return LocalDateTime(day.year, day.month, day.day, t.hour, t.minute)
        .toInstant(zone)
        .toEpochMilliseconds()
}
/** Padded `HH:mm` so plain string comparison orders times. */
private fun padHHmm(v: String): String {
    val parts = v.split(":")
    return "${parts.getOrElse(0) { "" }.padStart(2, '0')}:${parts.getOrElse(1) { "" }}"
}
/**
 * The picker's closed-day map: the company closures plus every date in
 * `[today, today + horizonDays]` that falls on a weekday the business is shut.
 * Same shape as the wizard's `closedDates`, so the shared month grid needs no
 * new parameter.
 */
fun closedDaysFor(
    closures: Map<String, String>,
    weekly: List<WeekdayHours>,
    today: LocalDate,
    horizonDays: Int,
): Map<String, String> {
    val closedWeekdays = weekly.filter { !it.open }.map { it.weekday }.toSet()
    if (closedWeekdays.isEmpty()) return closures
    val out = closures.toMutableMap()
    for (i in 0..horizonDays) {
        val d = LocalDate.fromEpochDays(today.toEpochDays() + i)
        val key = bookingDateKey(d)
        if (d.sundayZeroWeekday() in closedWeekdays && key !in out) {
            out[key] = "${WEEKDAY_NAMES[d.sundayZeroWeekday()]}s"
        }
    }
    return out
}
/** The weekday's hours, or null when the business has none on file (no restriction known). */
fun hoursOn(day: LocalDate, weekly: List<WeekdayHours>): WeekdayHours? {
    if (weekly.size != 7) return null
    return weekly.firstOrNull { it.weekday == day.sundayZeroWeekday() }
}
/** Which ways of saying WHEN this visit can use, and the one to open on. */
data class RescheduleModes(val modes: List<BookingMode>, val initial: BookingMode)
fun rescheduleModes(policy: BookingPolicy, serviceId: String?): RescheduleModes {
    // #1092: a start-time KinCare books by the clock whatever the switches say.
    if (serviceId != null && serviceId in policy.startTimeServiceIds) {
        return RescheduleModes(listOf(BookingMode.SpecificTime), BookingMode.SpecificTime)
    }
    val modes = buildList {
        if (policy.allowTimeBlockBooking) add(BookingMode.TimeBlock)
        if (policy.allowSpecificTimeBooking) add(BookingMode.SpecificTime)
    }
    if (modes.isEmpty()) return RescheduleModes(listOf(BookingMode.SpecificTime), BookingMode.SpecificTime)
    val initial = policy.defaultBookingMode.takeIf { it in modes } ?: modes.first()
    return RescheduleModes(modes, initial)
}
/** A block still bookable on a day, with the instant the request is carried on. */
data class BlockChoice(val block: TimeBlock, val startMs: Long)
/**
 * The blocks still bookable on [day], each with the instant to send. A block
 * whose first minute has passed starts a little after now if that still fits
 * before it closes, and is dropped otherwise (the wizard's open-block rule, on
 * the business clock).
 */
fun blockChoices(day: LocalDate, blocks: List<TimeBlock>, nowMs: Long, timeZoneId: String): List<BlockChoice> =
    blocks.mapNotNull { block ->
        val firstMs = zonedWallClockToMs(day, block.startTime, timeZoneId) ?: return@mapNotNull null
        val endMs = zonedWallClockToMs(day, block.endTime, timeZoneId) ?: return@mapNotNull null
        if (firstMs > nowMs) return@mapNotNull BlockChoice(block, firstMs)
        val earliest = nowMs + OPEN_BLOCK_LEAD_MINUTES * 60_000L
        val anchored = ((earliest + OPEN_BLOCK_STEP_MS - 1) / OPEN_BLOCK_STEP_MS) * OPEN_BLOCK_STEP_MS
        if (anchored < endMs) BlockChoice(block, anchored) else null
    }
/** What to send: the instant, and the block it sits in (null for a clock time). */
data class RescheduleProposal(val startMs: Long, val timeBlockId: String?)
/** The proposal, or why there is none yet. [problem] is null while the household has not finished choosing. */
data class ProposalResult(val proposal: RescheduleProposal?, val problem: String?)
fun resolveProposal(
    day: LocalDate?,
    mode: BookingMode,
    time: String,
    blockId: String?,
    blocks: List<TimeBlock>,
    weekly: List<WeekdayHours>,
    timeZoneId: String,
    nowMs: Long,
    startTimeService: Boolean,
): ProposalResult {
    val none = ProposalResult(null, null)
    if (day == null) return none
    if (mode == BookingMode.TimeBlock) {
        if (blockId == null) return none
        val choice = blockChoices(day, blocks, nowMs, timeZoneId).firstOrNull { it.block.id == blockId }
            ?: return ProposalResult(null, "That block has already passed on this day. Pick a later block or another day.")
        return ProposalResult(RescheduleProposal(choice.startMs, choice.block.id), null)
    }
    if (parseClock24(time) == null) return none
    val hours = hoursOn(day, weekly)
    if (hours != null && !startTimeService && hours.open && hours.startTime != null && hours.endTime != null) {
        val t = padHHmm(time.trim())
        if (t < hours.startTime || t >= hours.endTime) {
            return ProposalResult(
                null,
                "We are open ${hours.startTime} to ${hours.endTime} on ${WEEKDAY_NAMES[hours.weekday]}s. Pick a time inside those hours.",
            )
        }
    }
    val startMs = zonedWallClockToMs(day, time, timeZoneId) ?: return none
    return ProposalResult(RescheduleProposal(startMs, null), null)
}
