package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk

/**
 * Pure, JVM-testable decision logic for the Stage-2 Step-2 features that were
 * promoted from dark feature flags to always-on. Kept free of Compose / Firestore
 * so each can be exercised in plain unit tests. Function names + behavior mirror
 * the web `com.tribetails.auntieos.web.screens.Stage2Step2Helpers` so both clients
 * resolve identically.
 */

/** A date prefix in YYYY-MM-DD shape, or null if the field isn't usable. */
internal fun isoDatePrefixOrNull(date: String): String? =
    date.trim().take(10).takeIf { it.length == 10 && it[4] == '-' && it[7] == '-' }

// ── Directory: last completed visit per kinfolk (directory.lastVisit) ───────────

/**
 * Map each kinfolkId to the ISO date (YYYY-MM-DD) of its most recent COMPLETED
 * Kin Care session. A session counts as completed when its status is COMPLETED;
 * the visit instant is the session's [KinCareSession.completedAt] when present,
 * else its [KinCareSession.startTime] (a completed session always happened, so
 * the start is an honest fallback when the completedAt stamp is missing).
 *
 * Only the date prefix is kept (callers render a date, not a time). Sessions with
 * no parseable date are skipped (never fabricate an ordering). The latest date
 * per kinfolk wins via lexical comparison on the fixed YYYY-MM-DD form.
 */
fun lastVisitByKinfolk(sessions: List<KinCareSession>): Map<String, String> {
    val out = HashMap<String, String>()
    for (s in sessions) {
        if (s.status.uppercase() != "COMPLETED") continue
        if (s.kinfolkId.isBlank()) continue
        val stamp = s.completedAt.ifBlank { s.startTime }
        val date = isoDatePrefixOrNull(stamp) ?: continue
        val prev = out[s.kinfolkId]
        if (prev == null || date > prev) out[s.kinfolkId] = date
    }
    return out
}

/**
 * Count the KinTales (sent visit reports) each kinfolk has received, summed from
 * each session's [KinCareSession.sentReportCount]. Feeds the zero-KinTale signal of
 * [isNewKinfolk]. A kinfolk with no entry has zero KinTales. Pure; tested.
 */
fun kintaleCountByKinfolk(sessions: List<KinCareSession>): Map<String, Int> {
    val out = HashMap<String, Int>()
    for (s in sessions) {
        if (s.kinfolkId.isBlank()) continue
        if (s.sentReportCount <= 0) continue
        out[s.kinfolkId] = (out[s.kinfolkId] ?: 0) + s.sentReportCount
    }
    return out
}

// ── Directory: NEW badge (directory.newBadge) ──────────────────────────────────

private const val NEW_KINFOLK_WINDOW_DAYS = 14L

/**
 * True when a kinfolk should carry a "New" badge: it was created within the last
 * [NEW_KINFOLK_WINDOW_DAYS] days OR it has zero KinTales sent yet.
 *
 * "Created" is read from [Kinfolk.joinDate] (the onboarding date; the Android model
 * has no separate createdAt). When joinDate is blank/unparseable, recency cannot be
 * proven, so newness rests solely on the zero-KinTale signal (never fabricate a
 * created date).
 *
 * @param nowIso a YYYY-MM-DD (or longer ISO) string; only the date prefix is used.
 */
fun isNewKinfolk(kinfolk: Kinfolk, kintaleCount: Int, nowIso: String): Boolean {
    if (kintaleCount <= 0) return true
    val today = isoDatePrefixOrNull(nowIso) ?: return false
    val joined = isoDatePrefixOrNull(kinfolk.joinDate) ?: return false
    val todayDay = isoToEpochDayOrNull(today) ?: return false
    val joinDay = isoToEpochDayOrNull(joined) ?: return false
    val ageDays = todayDay - joinDay
    return ageDays in 0..NEW_KINFOLK_WINDOW_DAYS
}

// ── Auntie Time: stacked kin avatars per session (auntieTime.multiPetAvatars) ──

/** Lightweight, Compose-free avatar descriptor for a session's kin cluster. */
data class KinAvatar(val imageUrl: String, val initials: String, val seed: String)

/**
 * Resolve the kin avatars to stack on a session. The session references its kin
 * via [KinCareSession.kinIds] (multi-kin) falling back to the single
 * [KinCareSession.kinId]; each id is joined against [kinById]. Unknown ids are
 * dropped (no placeholder face fabricated). Order follows the session's id order
 * so the render is stable.
 */
fun kinAvatarsForSession(
    session: KinCareSession,
    kinById: Map<String, Kin>,
): List<KinAvatar> {
    val ids = if (session.kinIds.isNotEmpty()) session.kinIds
              else listOfNotNull(session.kinId.ifBlank { null })
    return ids.mapNotNull { id ->
        val kin = kinById[id] ?: return@mapNotNull null
        KinAvatar(
            imageUrl = kin.profilePictureUrl,
            initials = kin.name,
            seed = kin.id.ifBlank { kin.name },
        )
    }
}

// ── Home: weekly revenue (home.weeklyRevenueStat) ──────────────────────────────

/**
 * Canonical "paid" test for revenue: a non-draft invoice with a positive total and
 * nothing still owed. Mirrors InvoicesScreen.invoiceIsPaid + the web invoiceIsPaid.
 */
internal fun invoiceIsPaidForRevenue(i: Invoice): Boolean =
    !i.status.equals("draft", ignoreCase = true) && i.amountDue <= 0.0 && i.total > 0.0

/**
 * Sum the totals of PAID invoices whose invoice date falls within the current
 * week window [weekStartIso] .. [nowIso] (both inclusive on the date prefix). Paid
 * is decided by the canonical [invoiceIsPaidForRevenue] test. Invoices with an
 * unparseable date are skipped (never count money we cannot place in the week).
 *
 * @param weekStartIso YYYY-MM-DD of the week's first day (e.g. Monday).
 * @param nowIso       YYYY-MM-DD of today (the week's upper bound).
 */
fun weeklyRevenue(invoices: List<Invoice>, weekStartIso: String, nowIso: String): Double {
    val start = isoDatePrefixOrNull(weekStartIso) ?: return 0.0
    val end = isoDatePrefixOrNull(nowIso) ?: return 0.0
    var sum = 0.0
    for (inv in invoices) {
        if (!invoiceIsPaidForRevenue(inv)) continue
        val date = isoDatePrefixOrNull(inv.date) ?: continue
        if (date in start..end) sum += inv.total
    }
    return sum
}

// ── Schedule: reschedule arg mapping (schedule.dragReschedule) ─────────────────

/** The (startTime, endTime) args a reschedule maps to for rescheduleBooking. */
data class RescheduleArgs(val sessionId: String, val startTime: String, val endTime: String)

/**
 * Map a chosen new day + minute-of-day for a visit into the ISO start/end strings
 * the rescheduleBooking callable expects. The new start is
 * [targetDateIso]T[HH:mm]:00, snapped to [snapMinutes]. The end preserves the
 * session's original duration (from serviceDurationMinutes, else the original
 * start->end span, else a 30-minute default) so a reschedule never silently
 * resizes the visit.
 *
 * Returns null when the session has no id or the target minute is out of range
 * (fail loud: the caller must not invoke the callable with junk args).
 *
 * @param targetDateIso YYYY-MM-DD of the chosen day.
 * @param dropMinuteOfDay minutes-from-midnight of the chosen start (0..1439).
 * @param snapMinutes grid snap granularity (mockup DRAG_MINUTE_SNAP = 15).
 */
fun rescheduleArgsForDrop(
    session: KinCareSession,
    targetDateIso: String,
    dropMinuteOfDay: Int,
    snapMinutes: Int = 15,
): RescheduleArgs? {
    if (session.id.isBlank()) return null
    if (dropMinuteOfDay !in 0..1439) return null
    val date = isoDatePrefixOrNull(targetDateIso) ?: return null

    val snap = if (snapMinutes <= 0) 1 else snapMinutes
    val snapped = (dropMinuteOfDay / snap) * snap

    val durationMinutes = resolveDurationMinutes(session)
    val endMinute = (snapped + durationMinutes).coerceAtMost(1439)

    val start = "${date}T${hhmm(snapped)}:00"
    val end = "${date}T${hhmm(endMinute)}:00"
    return RescheduleArgs(sessionId = session.id, startTime = start, endTime = end)
}

/** Original visit duration in minutes: explicit field, else start->end span, else 30. */
internal fun resolveDurationMinutes(session: KinCareSession): Int {
    if (session.serviceDurationMinutes > 0) return session.serviceDurationMinutes
    val startM = isoMinuteOfDayOrNull(session.startTime)
    val endM = isoMinuteOfDayOrNull(session.endTime)
    if (startM != null && endM != null && endM > startM) return endM - startM
    return 30
}

private fun hhmm(minuteOfDay: Int): String {
    val h = (minuteOfDay / 60).coerceIn(0, 23)
    val m = (minuteOfDay % 60).coerceIn(0, 59)
    return "${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}"
}

/** Positional minutes-of-day from an ISO "...THH:MM..." string, or null. */
private fun isoMinuteOfDayOrNull(iso: String): Int? {
    if (iso.length < 16 || iso[10] != 'T') return null
    val hour = iso.substring(11, 13).toIntOrNull() ?: return null
    val minute = iso.substring(14, 16).toIntOrNull() ?: return null
    if (hour !in 0..23 || minute !in 0..59) return null
    return hour * 60 + minute
}

/**
 * YYYY-MM-DD to a proleptic-Gregorian day index (Howard Hinnant's days-from-civil),
 * or null when out of range. Shared by the date-window helpers above; matches the
 * web helper so both clients agree on day arithmetic.
 */
internal fun isoToEpochDayOrNull(iso: String): Long? {
    val y = iso.substring(0, 4).toIntOrNull() ?: return null
    val m = iso.substring(5, 7).toIntOrNull() ?: return null
    val d = iso.substring(8, 10).toIntOrNull() ?: return null
    if (m !in 1..12 || d !in 1..31) return null
    val yAdj = if (m <= 2) y - 1 else y
    val era = (if (yAdj >= 0) yAdj else yAdj - 399) / 400
    val yoe = yAdj - era * 400
    val mp = (m + 9) % 12
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era.toLong() * 146097 + doe.toLong() - 719468
}
