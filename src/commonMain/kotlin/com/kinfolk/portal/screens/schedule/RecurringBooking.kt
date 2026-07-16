package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.portal.BookingVisit
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.plus
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Instant

// ─────────────────────────────────────────────────────────────────────────────
// Recurring (weekly) visit expansion (16.3). PURE + unit-tested: expands a weekly
// rule (which weekdays, for N weeks, at a time) into the explicit BookingVisit[]
// that requestBooking expects (the callable stores pattern/weeklyDays but does NOT
// expand dates server-side, so the client owns expansion - and doing it client-side
// keeps the kinfolk's local timezone correct). No new callable: this feeds the
// existing requestBookingMultiVisit(pattern=Weekly, weeklyDays, visits).
// ─────────────────────────────────────────────────────────────────────────────

/** Hard cap so a runaway rule can never create a huge batch. */
const val MAX_RECURRING_VISITS = 26

/** Day index 0=Sun..6=Sat (matches the server's weeklyDays 0-6). Pure. */
internal fun weekdayIndex(d: LocalDate): Int = (d.dayOfWeek.ordinal + 1) % 7

/** Parses "HH:MM" to a LocalTime, or null. Pure. */
fun parseHourMinuteOrNull(s: String): LocalTime? = try {
    val p = s.split(":")
    if (p.size != 2) null else LocalTime(p[0].trim().toInt(), p[1].trim().toInt())
} catch (_: Throwable) {
    null
}

/**
 * The number of visits a weekly rule INTENDS to create (days x weeks), ignoring
 * the future-only filter + the cap. Used to detect + surface cap truncation so it
 * is never silent. Pure.
 */
fun weeklyPotentialCount(weeklyDays: Set<Int>, weeks: Int): Int =
    if (weeks < 1) 0 else weeklyDays.size * weeks

/** First blocking reason for a weekly rule, or null when it is sendable. Pure. */
fun weeklyVisitsBlocker(weeklyDays: Set<Int>, weeks: Int, time: String): String? {
    if (weeklyDays.isEmpty()) return "Pick at least one day of the week."
    if (weeks < 1) return "Choose how many weeks."
    if (parseHourMinuteOrNull(time) == null) return "Enter a valid time as HH:MM."
    return null
}

/**
 * Expands a weekly rule into concrete future BookingVisits. Walks each calendar
 * day from "now" for [weeks] weeks, emitting a visit at [time] for every day whose
 * weekday is in [weeklyDays] and whose datetime is strictly in the future (so the
 * server's past-start rejection never trips). Capped at [MAX_RECURRING_VISITS].
 * Pure (now is injected as [nowMs]) so it is deterministic + unit-testable.
 */
fun buildWeeklyVisits(
    nowMs: Long,
    weeklyDays: Set<Int>,
    weeks: Int,
    time: LocalTime,
    serviceId: String,
    serviceName: String,
    priceCents: Long?,
    tz: TimeZone = TimeZone.currentSystemDefault(),
): List<BookingVisit> {
    if (weeklyDays.isEmpty() || weeks < 1) return emptyList()
    val today = Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(tz).date
    val out = ArrayList<BookingVisit>()
    val totalDays = weeks * 7
    var offset = 0
    while (offset < totalDays && out.size < MAX_RECURRING_VISITS) {
        val d = today.plus(offset, DateTimeUnit.DAY)
        if (weekdayIndex(d) in weeklyDays) {
            val dt = LocalDateTime(d.year, d.month, d.dayOfMonth, time.hour, time.minute)
            val ms = dt.toInstant(tz).toEpochMilliseconds()
            if (ms > nowMs) {
                out.add(
                    BookingVisit(
                        startTimeMs = ms,
                        endTimeMs = null,
                        serviceId = serviceId,
                        serviceName = serviceName,
                        priceCents = priceCents,
                    ),
                )
            }
        }
        offset++
    }
    return out
}
