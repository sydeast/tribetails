package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.KinCareSession

/**
 * Auntie Time's window, sort and date labels: the pure half of
 * [KinCareSessionsScreen], and the Kotlin twin of the web admin's
 * `src/lib/sessionFormat.ts`. Extracted so the rules that decide what an
 * operator sees are unit-tested rather than buried in a Composable.
 *
 * The three window rules, all matching web:
 *
 *  RECENT IS TODAY OR YESTERDAY, which is what the
 *  `auntieos-auntie-time-2026-05-27` mock labels its Recent group. Issue #17
 *  had widened it to a week, on the reading that "recent" meant however long
 *  "did that one get wrapped?" stays a live question; #703 is the operator
 *  ruling that the mock is the spec, and the mock is narrower. Measured on the
 *  WRAP day, which is completedAt when there is one and startTime otherwise,
 *  because a CANCELLED visit never gets a completedAt and dropping it would
 *  quietly empty the cancelled half of Recent.
 *
 *  UPCOMING keeps the fourteen-day horizon and the one-day look-back it always
 *  had: "yesterday" still reads as today's run sheet, not yet a problem case.
 *
 *  ACTIVE has no date bound at all. In flight is in flight whatever the
 *  startTime says, so a clock-in nobody closed can never fall out of the list.
 *
 * ISSUE #702 added a fourth case: a visit still sitting at SCHEDULED more than
 * a day after its slot used to fall out of [isVisibleOnAuntieTime] entirely
 * (the one-day look-back above was its only allowance), so the exact row an
 * operator most needs to see disappeared outright. It now stays visible,
 * OVERDUE, back through [OVERDUE_WINDOW_DAYS]. That cap exists only on
 * Android: unlike the web admin's `sessionsWindowPageQuery`, this screen's
 * `getKinCareSessions()` fetches the whole collection with no date bound and
 * there is no Archive here to hand older rows to, so somewhere has to stop an
 * ancient dangling SCHEDULED row from resurfacing forever. Thirty days matches
 * the web fetch's own backstop (`FETCH_DAYS_BACK` in `sessionFormat.ts`).
 *
 * DRAFT / PENDING / REJECTED stay hidden and are matched POSITIVELY by name
 * (the archive's AO-60: the Bookings screen owns that queue). A status code no
 * writer produces today is therefore not swept in with them; it lands in
 * Upcoming or Overdue by its date, carrying its own honest status pill.
 */

const val RECENT_WINDOW_DAYS = 1
const val UPCOMING_WINDOW_DAYS = 14

/** How far back a SCHEDULED (or unrecognized-status) visit stays visible once
 * its slot has passed. See the ISSUE #702 note above for why Android needs an
 * explicit cap here where web does not. */
const val OVERDUE_WINDOW_DAYS = 30

/** Sort direction the operator picks. Applied WITHIN a phase, never across phases. */
enum class AuntieTimeSort(val label: String) {
    Soonest("Soonest first"),
    Latest("Latest first"),
}

/** The booking-queue states the Bookings screen owns; never shown on Auntie Time. */
private val BOOKING_QUEUE_STATUSES = setOf("DRAFT", "PENDING", "REJECTED")

internal fun isBookingQueueStatus(status: String): Boolean =
    status.trim().uppercase() in BOOKING_QUEUE_STATUSES

private val ACTIVE_STATUSES = setOf("ON_MY_WAY", "ARRIVED", "DEPARTED")

private val WRAPPED_STATUSES = setOf("COMPLETED", "CANCELLED")

/**
 * The day a wrapped visit is dated by: completedAt when present, else the start
 * it was scheduled for. Returns "" when neither parses to a date.
 */
internal fun wrapDayOf(session: KinCareSession): String {
    val completed = session.completedAt.orEmpty().take(10)
    if (completed.length == 10) return completed
    return session.startTime.take(10).takeIf { it.length == 10 }.orEmpty()
}

/**
 * Whether [session] belongs in the day-of list at all, given [today] as
 * "YYYY-MM-DD" (a LOCAL date; see the AO-18 note in [KinCareSessionsScreen]).
 * Everything else is older history and belongs behind an archive view.
 */
internal fun isVisibleOnAuntieTime(session: KinCareSession, today: String): Boolean {
    val status = session.status.uppercase()
    if (isBookingQueueStatus(status)) return false
    if (status in ACTIVE_STATUSES) return true

    if (status in WRAPPED_STATUSES) {
        val wrapDay = wrapDayOf(session)
        if (wrapDay.isEmpty()) return false
        return wrapDay in dateAddDays(today, -RECENT_WINDOW_DAYS)..today
    }

    // SCHEDULED, plus any code no writer produces today: placed by its date,
    // which we do know, rather than dropped over a word we do not. Issue #702:
    // the lower bound used to be `today - 1`, so anything older simply
    // vanished; it now reaches back to OVERDUE_WINDOW_DAYS instead of
    // dropping the row outright.
    val date = session.startTime.take(10)
    if (date.length < 10) return false
    return date in dateAddDays(today, -OVERDUE_WINDOW_DAYS)..dateAddDays(today, UPCOMING_WINDOW_DAYS)
}

/**
 * Whether [session] is a SCHEDULED (or unrecognized-status) visit whose slot
 * passed more than a day ago, issue #702's OVERDUE phase. Active and wrapped
 * statuses are never overdue by this definition, they have their own phases.
 */
internal fun isOverdueScheduled(session: KinCareSession, today: String): Boolean {
    val status = session.status.uppercase()
    if (isBookingQueueStatus(status) || status in ACTIVE_STATUSES || status in WRAPPED_STATUSES) {
        return false
    }
    val date = session.startTime.take(10)
    if (date.length < 10) return false
    return date < dateAddDays(today, -1)
}

/**
 * One phase's sessions in the operator's chosen direction. Ascending by
 * startTime is the natural order; "latest first" is that same order reversed,
 * so the two are always exact mirrors.
 */
internal fun sortSessions(
    sessions: List<KinCareSession>,
    sort: AuntieTimeSort,
): List<KinCareSession> {
    val ascending = sessions.sortedBy { it.startTime }
    return if (sort == AuntieTimeSort.Latest) ascending.reversed() else ascending
}

private val MONTHS =
    listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * "Jul 16 · 14:00", and "Jan 16, 2025 · 14:00" once the year is not [todayIso]'s.
 *
 * Without the year a visit from last January read exactly like this January,
 * which is the one thing a dated label must never be ambiguous about. Omitted
 * in the current year so the common case stays short.
 */
internal fun auntieTimeDate(iso: String, todayIso: String): String =
    runCatching {
        if (iso.length < 16) return@runCatching iso
        val year = iso.substring(0, 4)
        val month = MONTHS[iso.substring(5, 7).toInt() - 1]
        val day = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
        val time = iso.substring(11, 16)
        val yearSuffix = if (year == todayIso.take(4)) "" else ", $year"
        "$month $day$yearSuffix · $time"
    }.getOrDefault(iso)

internal fun auntieTimeClock(iso: String): String =
    runCatching { if (iso.length >= 16) iso.substring(11, 16) else iso }.getOrDefault(iso)

/** "09:00 to 17:00", with the start's date (and year, when it needs one). */
internal fun sessionWindow(session: KinCareSession, todayIso: String): String {
    val start = auntieTimeDate(session.startTime, todayIso)
    val end = auntieTimeClock(session.endTime)
    return when {
        start.isBlank() && end.isBlank() -> "Time TBD"
        end.isBlank() -> start
        else -> "$start to $end"
    }
}

/** Add [days] days to an ISO date string "YYYY-MM-DD". Handles month/year rollover. */
internal fun dateAddDays(iso: String, days: Int): String = runCatching {
    if (iso.length < 10) return@runCatching iso
    var y = iso.substring(0, 4).toInt()
    var m = iso.substring(5, 7).toInt()
    var d = iso.substring(8, 10).toInt() + days
    while (d < 1) { m--; if (m < 1) { m = 12; y-- }; d += daysInMonth(y, m) }
    while (d > daysInMonth(y, m)) { d -= daysInMonth(y, m); m++; if (m > 12) { m = 1; y++ } }
    val ys = y.toString().padStart(4, '0')
    val ms = m.toString().padStart(2, '0')
    val ds = d.toString().padStart(2, '0')
    "$ys-$ms-$ds"
}.getOrDefault(iso)

private fun daysInMonth(y: Int, m: Int) = when (m) {
    1, 3, 5, 7, 8, 10, 12 -> 31
    4, 6, 9, 11 -> 30
    2 -> if (y % 400 == 0 || (y % 4 == 0 && y % 100 != 0)) 29 else 28
    else -> 30
}
