package com.tribetails.auntieos.web.screens

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.invoices.InvoiceState
import com.tribetails.auntieos.web.screens.invoices.invoiceIsArchived
import com.tribetails.auntieos.web.screens.invoices.invoiceIsPaid
import com.tribetails.auntieos.web.screens.invoices.invoiceStateOrNull
import com.tribetails.auntieos.web.screens.invoices.invoiceWrittenOffCentsOf
import com.tribetails.auntieos.web.screens.invoices.isoDatePrefixOrNull

/**
 * Pure, JVM-testable decision logic for the Stage-2 Step-2 features that were
 * promoted from dark feature flags to always-on. Kept free of Compose / Firestore
 * so each can be exercised in commonTest.
 */

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
fun lastVisitByKinfolk(
    sessions: List<KinCareSession>,
    zone: kotlinx.datetime.TimeZone = com.tribetails.auntieos.web.util.businessTimeZone(),
): Map<String, String> {
    val out = HashMap<String, String>()
    for (s in sessions) {
        if (s.status.uppercase() != "COMPLETED") continue
        if (s.kinfolkId.isBlank()) continue
        val stamp = s.completedAt.ifBlank { s.startTime }
        // #2095: the business day, not the UTC date of an instant.
        val date = isoDatePrefixOrNull(com.tribetails.auntieos.web.screens.sessions.businessDayOf(stamp, zone)) ?: continue
        val prev = out[s.kinfolkId]
        if (prev == null || date > prev) out[s.kinfolkId] = date
    }
    return out
}

// ── Directory: NEW badge (directory.newBadge) ──────────────────────────────────

private const val NEW_KINFOLK_WINDOW_DAYS = 14L

/**
 * True when a kinfolk should carry a "New" badge: it was created within the last
 * [NEW_KINFOLK_WINDOW_DAYS] days OR it has zero KinTales sent yet.
 *
 * "Created" is read from [Kinfolk.joinDate] (the onboarding date). When joinDate
 * is blank/unparseable, recency cannot be proven, so newness rests solely on the
 * zero-KinTale signal (never fabricate a created date).
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
            seed = kin._id.ifBlank { kin.name },
        )
    }
}

// ── Home: weekly revenue (home.weeklyRevenueStat) ──────────────────────────────

/**
 * Sum the totals of PAID invoices whose invoice date falls within the current
 * week window [weekStartIso] .. [nowIso] (both inclusive on the date prefix). Paid
 * is decided by the canonical [invoiceIsPaid] test. Invoices with an unparseable
 * date are skipped (never count money we cannot place in the week).
 *
 * @param weekStartIso YYYY-MM-DD of the week's first day (e.g. Monday).
 * @param nowIso       YYYY-MM-DD of today (the week's upper bound).
 */
fun weeklyRevenue(invoices: List<Invoice>, weekStartIso: String, nowIso: String): Double {
    val start = isoDatePrefixOrNull(weekStartIso) ?: return 0.0
    val end = isoDatePrefixOrNull(nowIso) ?: return 0.0
    var sum = 0.0
    for (inv in invoices) {
        val earned = invoiceRevenueOf(inv)
        if (earned <= 0.0) continue
        val date = isoDatePrefixOrNull(inv.date) ?: continue
        if (date in start..end) sum += earned
    }
    return sum
}

/**
 * What one invoice adds to revenue, in dollars: its total when paid, and for a
 * written-off one (#2090) only what came in before the rest was written off.
 * Checked before [invoiceIsPaid], which reads any non-draft invoice with no
 * balance as paid and so would count the written-off part as money collected.
 * Mirrors the web's `revenueOf` and Android's `invoiceRevenueOf`.
 */
internal fun invoiceRevenueOf(inv: Invoice): Double {
    if (invoiceStateOrNull(inv) == InvoiceState.WRITTEN_OFF) {
        val writtenOff = invoiceWrittenOffCentsOf(inv) ?: 0L
        return maxOf(0L, kotlin.math.round(inv.total * 100.0).toLong() - writtenOff) / 100.0
    }
    return if (invoiceIsPaid(inv)) inv.total else 0.0
}

// ── Home: Cash Flow outstanding (home.cashFlow) ────────────────────────────────
/** What the Cash Flow card says is still owed, and across how many invoices. */
data class CashFlowOutstanding(val total: Double, val count: Int)
/**
 * #2000: what households have been asked to pay and have not. Stored state
 * OPEN, a balance above zero, not archived: the rule the web Invoices screen's
 * Outstanding card and Android's Invoices tile both read, so Home agrees with
 * them. This console's own Invoices Outstanding tile calls this function too
 * (`screens/invoices/InvoicesScreen.kt#SummaryStrip`).
 *
 * A POSITIVE test on the stamp. An unsent draft has gone to nobody and a quote
 * is not a bill, so neither is owed; this card used to count every invoice with
 * a balance and read an unsent draft as money unpaid. An archived invoice has
 * been written off. The web's `outstandingTotals` and Android's
 * `domain/Stage2Step2Helpers.kt#cashFlowOutstanding` are the same function.
 */
fun cashFlowOutstanding(invoices: List<Invoice>): CashFlowOutstanding {
    var total = 0.0
    var count = 0
    for (inv in invoices) {
        if (invoiceIsArchived(inv)) continue
        if (invoiceStateOrNull(inv) != InvoiceState.OPEN) continue
        if (!(inv.amountDue > 0.0)) continue
        total += inv.amountDue
        count += 1
    }
    return CashFlowOutstanding(total, count)
}
// ── Schedule: drag-to-reschedule arg mapping (schedule.dragReschedule) ─────────

/** The (startTime, endTime) args a drag drop maps to for rescheduleBooking. */
data class RescheduleArgs(val sessionId: String, val startTime: String, val endTime: String)

/**
 * Map a drag-drop of a visit block onto a new day + minute-of-day into the ISO
 * start/end strings the rescheduleBooking callable expects. The new start is
 * [targetDateIso]T[HH:mm]:00, snapped to [snapMinutes]. The end preserves the
 * session's original duration (from serviceDurationMinutes, else the original
 * start->end span, else a 30-minute default) so a reschedule never silently
 * resizes the visit.
 *
 * Returns null when the session has no id or the target minute is out of range
 * (fail loud: the caller must not invoke the callable with junk args).
 *
 * @param targetDateIso YYYY-MM-DD of the column the block was dropped on.
 * @param dropMinuteOfDay minutes-from-midnight of the drop position (0..1439).
 * @param snapMinutes grid snap granularity (mockup DRAG_MINUTE_SNAP = 15).
 */
fun rescheduleArgsForDrop(
    session: KinCareSession,
    targetDateIso: String,
    dropMinuteOfDay: Int,
    snapMinutes: Int = 15,
): RescheduleArgs? {
    if (session._id.isBlank()) return null
    if (dropMinuteOfDay !in 0..1439) return null
    val date = isoDatePrefixOrNull(targetDateIso) ?: return null

    val snap = if (snapMinutes <= 0) 1 else snapMinutes
    val snapped = (dropMinuteOfDay / snap) * snap

    val durationMinutes = resolveDurationMinutes(session)
    val endMinute = (snapped + durationMinutes).coerceAtMost(1439)

    val start = "${date}T${hhmm(snapped)}:00"
    val end = "${date}T${hhmm(endMinute)}:00"
    return RescheduleArgs(sessionId = session._id, startTime = start, endTime = end)
}

/** Original visit duration in minutes: explicit field, else start->end span, else 30. */
@OptIn(kotlin.time.ExperimentalTime::class)
internal fun resolveDurationMinutes(
    session: KinCareSession,
    zone: kotlinx.datetime.TimeZone = com.tribetails.auntieos.web.util.businessTimeZone(),
): Int {
    if (session.serviceDurationMinutes > 0) return session.serviceDurationMinutes
    // #2095: the span between the two moments, in either stored shape. Reading
    // hours and minutes off the text made a visit that crossed midnight (UTC
    // midnight is 6 PM in Chicago in winter) look negative, and it fell to 30.
    val start = com.tribetails.auntieos.web.screens.sessions.businessInstantOf(session.startTime, zone)
    val end = com.tribetails.auntieos.web.screens.sessions.businessInstantOf(session.endTime, zone)
    if (start != null && end != null) {
        val minutes = (end - start).inWholeMinutes
        if (minutes in 1..1439) return minutes.toInt()
    }
    return 30
}

private fun hhmm(minuteOfDay: Int): String {
    val h = (minuteOfDay / 60).coerceIn(0, 23)
    val m = (minuteOfDay % 60).coerceIn(0, 59)
    return "${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}"
}

/**
 * YYYY-MM-DD to a proleptic-Gregorian day index (Howard Hinnant's days-from-civil),
 * or null when out of range. Shared by the date-window helpers above; avoids any
 * java.time dependency that is unavailable on Wasm.
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
