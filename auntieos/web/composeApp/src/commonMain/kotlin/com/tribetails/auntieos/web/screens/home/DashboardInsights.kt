package com.tribetails.auntieos.web.screens.home

import com.tribetails.auntieos.web.data.ExpenseItem
import com.tribetails.auntieos.web.data.ExpirationItem
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.SupplyItem
import com.tribetails.auntieos.web.screens.inbox.ConversationSummary
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.isoDayNumber
import kotlinx.datetime.plus

/**
 * A8 dashboard insight widgets: the pure logic behind Weekly capacity (W8),
 * Overdue visits (W9), Pets by type (W10), Frequent flyers (W11) and Holiday
 * runway (W13). Compose-free so every rule is unit-testable on the JVM; see
 * [DashboardInsightsTest]. The composables live in HomeInsightWidgets.kt.
 */

private fun parseDay(s: String): LocalDate? =
    runCatching { LocalDate.parse(s.take(10)) }.getOrNull()

private fun LocalDate.mondayOfWeek(): LocalDate =
    plus(-(dayOfWeek.isoDayNumber - 1), DateTimeUnit.DAY)

private val CANCELLED_STATUSES = setOf("CANCELLED", "CANCELED")

private fun KinCareSession.isCancelled(): Boolean = status.uppercase() in CANCELLED_STATUSES

// ── W8 weekly capacity ────────────────────────────────────────────────────────

/**
 * This week's booked visits vs a derived capacity. BusinessSettings carries no
 * capacity target, so the denominator is the busiest single week in the trailing
 * 4 full weeks ([record]), floored at [booked] (a record-beating week reads as a
 * full bar, never an overflow) and at 1. Labelled honestly in the widget as
 * "vs your busiest recent week".
 */
data class WeeklyCapacity(val booked: Int, val record: Int, val capacity: Int) {
    val fraction: Float get() = if (capacity <= 0) 0f else (booked.toFloat() / capacity).coerceIn(0f, 1f)
    val beatingRecord: Boolean get() = record in 1 until booked || (record == 0 && booked > 0)
}

fun weeklyCapacity(sessions: List<KinCareSession>, todayIso: String): WeeklyCapacity? {
    val today = parseDay(todayIso) ?: return null
    val monday = today.mondayOfWeek()
    fun weekCount(weekStart: LocalDate): Int {
        val weekEnd = weekStart.plus(7, DateTimeUnit.DAY)
        return sessions.count { s ->
            if (s.isCancelled()) return@count false
            val d = parseDay(s.startTime) ?: return@count false
            d >= weekStart && d < weekEnd
        }
    }
    val booked = weekCount(monday)
    val record = (1..4).maxOf { weekCount(monday.plus(-7 * it, DateTimeUnit.DAY)) }
    return WeeklyCapacity(booked = booked, record = record, capacity = maxOf(record, booked, 1))
}

// ── W9 overdue visits ─────────────────────────────────────────────────────────

data class OverdueVisit(
    val sessionId: String,
    val kinfolkName: String,
    val serviceType: String,
    val endedAt: String,
)

/**
 * Visits whose end time (falling back to start time when no end is recorded)
 * has passed without the session reaching COMPLETED. Cancelled visits are not
 * overdue, and rows older than [withinDays] are treated as stale data rather
 * than actionable work. Most recently ended first, so the freshest miss tops
 * the list. ISO strings compare lexicographically, so no clock math is needed.
 */
fun overdueVisits(
    sessions: List<KinCareSession>,
    nowIso: String,
    withinDays: Int = 30,
): List<OverdueVisit> {
    val today = parseDay(nowIso) ?: return emptyList()
    val staleBefore = today.plus(-withinDays, DateTimeUnit.DAY)
    return sessions
        .mapNotNull { s ->
            val status = s.status.uppercase()
            if (status == "COMPLETED" || s.isCancelled()) return@mapNotNull null
            val end = s.endTime.ifBlank { s.startTime }
            val endDay = parseDay(end) ?: return@mapNotNull null
            if (end >= nowIso || endDay < staleBefore) return@mapNotNull null
            OverdueVisit(
                sessionId = s._id,
                kinfolkName = s.kinfolkName.ifBlank { "Kinfolk" },
                serviceType = s.serviceType,
                endedAt = end,
            )
        }
        .sortedByDescending { it.endedAt }
}

// ── W10 pets by type ──────────────────────────────────────────────────────────

data class SpeciesSlice(val species: String, val count: Int)

/**
 * Active kin grouped by species (trimmed + title-cased so "dog"/"Dog"/"DOG"
 * land in one slice; blank reads as "Unknown"), biggest slice first with a
 * stable name tiebreak.
 */
fun speciesBreakdown(kin: List<Kin>): List<SpeciesSlice> =
    kin.asSequence()
        .filter { it.status.lowercase() != "archived" }
        .map { k ->
            k.species.trim()
                .lowercase()
                .replaceFirstChar { it.uppercase() }
                .ifBlank { "Unknown" }
        }
        .groupingBy { it }
        .eachCount()
        .map { (species, count) -> SpeciesSlice(species, count) }
        .sortedWith(compareByDescending<SpeciesSlice> { it.count }.thenBy { it.species })

// ── W11 frequent flyers ───────────────────────────────────────────────────────

data class FrequentFlyer(val household: String, val visits: Int)

/**
 * Top households by COMPLETED visits over the trailing [days] (default 90),
 * grouped by kinfolkId (name fallback) like householdVisitGaps. Most visits
 * first; households with no name are dropped.
 */
fun frequentFlyers(
    sessions: List<KinCareSession>,
    todayIso: String,
    days: Int = 90,
    limit: Int = 5,
): List<FrequentFlyer> {
    val today = parseDay(todayIso) ?: return emptyList()
    val since = today.plus(-days, DateTimeUnit.DAY)
    return sessions
        .filter { s ->
            s.status.uppercase() == "COMPLETED" &&
                parseDay(s.completedAt.ifBlank { s.startTime })?.let { it in since..today } == true
        }
        .groupBy { it.kinfolkId.ifBlank { it.kinfolkName } }
        .mapNotNull { (_, group) ->
            val name = group.firstOrNull { it.kinfolkName.isNotBlank() }?.kinfolkName ?: return@mapNotNull null
            FrequentFlyer(name, group.size)
        }
        .sortedByDescending { it.visits }
        .take(limit)
}

// ── AO-38 / W6 unread client messages ─────────────────────────────────────────

data class UnreadMessageRow(
    val kinfolkId: String,
    val household: String,
    val preview: String,
    val atMs: Long,
)

/**
 * The most recent unread client threads for the "Unread Client Messages" widget
 * (AO-38 / W6). Keeps only rows the admin has not read ([ConversationSummary.
 * unreadForAdmin], the positive signal, never a negation), most recent first,
 * capped at [limit]. Blank name falls back to the id and blank preview trims to
 * "". Mirrors the React `unreadClientMessages` (lib/dashboardInsights.ts).
 */
fun unreadClientMessages(rows: List<ConversationSummary>, limit: Int = 5): List<UnreadMessageRow> =
    rows.asSequence()
        .filter { it.unreadForAdmin }
        .sortedByDescending { it.lastMessageAtMs }
        .take(limit.coerceAtLeast(0))
        .map { r ->
            UnreadMessageRow(
                kinfolkId = r.kinfolkId,
                household = r.kinfolkName.trim().ifBlank { r.kinfolkId },
                preview = r.lastMessagePreview.trim(),
                atMs = r.lastMessageAtMs,
            )
        }
        .toList()

/** Total unread threads (the widget headline), independent of the display cap. */
fun unreadClientMessageCount(rows: List<ConversationSummary>): Int = rows.count { it.unreadForAdmin }

// ── AO-36 / W3 key & code safebox ──────────────────────────────────────────────

/**
 * The single NEXT upcoming visit for the Key & Code Safebox widget (AO-36 / W3).
 * Earliest visit whose start is now or later ([nowIso] a full ISO instant, string
 * compare) and whose state is neither cancelled nor completed. Mirrors the React
 * nextUpcomingSession. `null` when nothing is coming up.
 */
fun nextUpcomingSession(sessions: List<KinCareSession>, nowIso: String): KinCareSession? =
    sessions.asSequence()
        .filter { !it.isCancelled() && it.status.uppercase() != "COMPLETED" }
        .filter { it.startTime.isNotBlank() && it.startTime >= nowIso }
        .minByOrNull { it.startTime }

data class AccessLine(val label: String, val value: String, val mono: Boolean = false)

/**
 * A household's access notes as display lines, blank fields dropped so a partial
 * household never renders an empty row. Codes/passwords flagged [mono]. Arrival
 * order: where you're going, how you get in, then the wifi once inside. Mirrors
 * the React safeboxAccessLines.
 */
fun safeboxAccessLines(k: Kinfolk): List<AccessLine> {
    val lines = mutableListOf<AccessLine>()
    fun add(label: String, value: String, mono: Boolean = false) {
        if (value.isNotBlank()) lines.add(AccessLine(label, value, mono))
    }
    add("Address", k.serviceAddress)
    add("Gate / door code", k.gateCode, mono = true)
    add("Entry notes", k.entryNotes)
    add("Parking", k.parkingInstructions)
    add("WiFi network", k.wifiName)
    add("WiFi password", k.wifiPassword, mono = true)
    return lines
}

// ── AO-37 care flags ──────────────────────────────────────────────────────────

/**
 * A single care alert for today's visits (AO-37). [kind] is "reactive" |
 * "medication" | "feeding"; [text] is the operator-facing detail.
 */
data class CareFlag(
    val kinName: String,
    val household: String,
    val kind: String,
    val text: String,
)

private val CARE_FLAG_RANK = mapOf("reactive" to 0, "medication" to 1, "feeding" to 2)

/**
 * Care flags for TODAY's visits (AO-37 / Care Flags widget). For each of today's
 * non-cancelled sessions, join the session's kin ([KinCareSession.kinIds], falling
 * back to the single [KinCareSession.kinId]) to [kinById] and emit a flag when the
 * kin is reactive ("Reactive, handle with care"), carries non-blank
 * medicationHealthNotes (kind medication), or a non-blank feedingBrand (kind
 * feeding). Deduped by (kinId, kind) so a kin on two visits flags once per kind,
 * and ordered reactive first, then medication, then feeding (stable within a kind).
 * Needs NO callable: reads the existing kin + kin_care_sessions streams. Mirrors
 * the React careFlags (lib/dashboardInsights.ts).
 */
fun careFlags(
    todaySessions: List<KinCareSession>,
    kinById: Map<String, Kin>,
    todayIso: String,
): List<CareFlag> {
    val today = todayIso.take(10)
    val seen = mutableSetOf<Pair<String, String>>()
    val out = mutableListOf<CareFlag>()
    todaySessions.asSequence()
        .filter { !it.isCancelled() }
        .filter { it.startTime.take(10) == today }
        .forEach { s ->
            val kinIds = s.kinIds.ifEmpty { listOfNotNull(s.kinId.takeIf { id -> id.isNotBlank() }) }
            val household = s.kinfolkName.ifBlank { "Kinfolk" }
            kinIds.forEach { kinId ->
                val kin = kinById[kinId] ?: return@forEach
                val kinName = kin.name.ifBlank { "This kin" }
                fun emit(kind: String, text: String) {
                    if (text.isNotBlank() && seen.add(kinId to kind)) {
                        out.add(CareFlag(kinName = kinName, household = household, kind = kind, text = text))
                    }
                }
                if (kin.reactive) emit("reactive", "Reactive, handle with care")
                emit("medication", kin.medicationHealthNotes.trim())
                emit("feeding", kin.feedingBrand.trim())
            }
        }
    return out.sortedBy { CARE_FLAG_RANK[it.kind] ?: Int.MAX_VALUE }
}

// ── AO-39 expiration countdown ────────────────────────────────────────────────

/** One row in the Expiration Countdown widget (AO-39). */
data class ExpRow(
    val label: String,
    val dateIso: String,
    val daysUntil: Int,
    val kind: String,
)

/**
 * Upcoming expirations within [withinDays] (AO-39). Keeps entries whose date is
 * today or later AND no more than [withinDays] out, sorted by date ascending, with
 * a days-until countdown. Undated / unparseable rows are dropped (never faked to
 * "0 days"). Mirrors the React upcomingExpirations (lib/dashboardInsights.ts).
 */
fun upcomingExpirations(
    items: List<ExpirationItem>,
    todayIso: String,
    withinDays: Int = 60,
): List<ExpRow> {
    val today = parseDay(todayIso) ?: return emptyList()
    val limit = today.plus(withinDays, DateTimeUnit.DAY)
    return items
        .mapNotNull { item ->
            val d = parseDay(item.dateIso) ?: return@mapNotNull null
            if (d < today || d > limit) return@mapNotNull null
            ExpRow(
                label = item.label,
                dateIso = item.dateIso.take(10),
                daysUntil = (d.toEpochDays() - today.toEpochDays()).toInt(),
                kind = item.kind,
            )
        }
        .sortedBy { it.dateIso }
}

// ── AO-40 expense quick-log ───────────────────────────────────────────────────

/**
 * The most recent expenses for the AO-40 widget, newest first by occurredAt (ISO
 * string compare), capped at [limit]. The week/month totals are server-provided.
 * Mirrors the React recentExpenses.
 */
fun recentExpenses(list: List<ExpenseItem>, limit: Int = 5): List<ExpenseItem> =
    list.sortedByDescending { it.occurredAt }.take(limit.coerceAtLeast(0))

/**
 * Whole-cents money as "$12.34" (AO-40). Negative amounts keep the sign in front
 * of the dollar sign ("-$1.50"). Mirrors the React formatCents.
 */
fun formatCents(cents: Int): String {
    val sign = if (cents < 0) "-" else ""
    val abs = if (cents < 0) -cents else cents
    val dollars = abs / 100
    val rem = (abs % 100).toString().padStart(2, '0')
    return "$sign$$dollars.$rem"
}

// ── AO-41 supplies tracker ────────────────────────────────────────────────────

/**
 * Supplies at or below their reorder threshold (onHand <= par), most depleted
 * first (by onHand - par ascending, so the deepest shortfall tops the list).
 * Mirrors the React lowSupplies.
 */
fun lowSupplies(list: List<SupplyItem>): List<SupplyItem> =
    list.filter { it.onHand <= it.par }.sortedBy { it.onHand - it.par }

// ── AO-35 route optimizer (formatting helpers; server does the optimize) ───────

/** Trip distance as "12.3 mi" (AO-35). Mirrors the React formatMiles. */
fun formatMiles(miles: Double): String {
    val rounded = kotlin.math.round(miles * 10) / 10
    return "$rounded mi"
}

/** Trip duration as "1h 05m" (or "45m" under an hour) (AO-35). Mirrors formatDuration. */
fun formatDuration(minutes: Int): String {
    val safe = minutes.coerceAtLeast(0)
    val h = safe / 60
    val m = safe % 60
    return if (h > 0) "${h}h ${m.toString().padStart(2, '0')}m" else "${m}m"
}

// ── W13 holiday runway ────────────────────────────────────────────────────────

data class PetCareHoliday(val name: String, val date: LocalDate)

private fun nthWeekday(year: Int, month: Int, isoWeekday: Int, n: Int): LocalDate {
    val first = LocalDate(year, month, 1)
    val offset = (isoWeekday - first.dayOfWeek.isoDayNumber + 7) % 7
    return first.plus(offset + 7 * (n - 1), DateTimeUnit.DAY)
}

private fun lastWeekday(year: Int, month: Int, lastDay: Int, isoWeekday: Int): LocalDate {
    val last = LocalDate(year, month, lastDay)
    return last.plus(-((last.dayOfWeek.isoDayNumber - isoWeekday + 7) % 7), DateTimeUnit.DAY)
}

/**
 * The standard US high-demand pet-care holidays for [year], dates computed
 * (not looked up): Memorial Day (last Monday of May), July 4th, Labor Day
 * (first Monday of September), Thanksgiving (fourth Thursday of November),
 * Christmas, New Year's Day. Sorted by date within the year.
 */
fun usPetCareHolidays(year: Int): List<PetCareHoliday> = listOf(
    PetCareHoliday("New Year's Day", LocalDate(year, 1, 1)),
    PetCareHoliday("Memorial Day", lastWeekday(year, 5, 31, isoWeekday = 1)),
    PetCareHoliday("July 4th", LocalDate(year, 7, 4)),
    PetCareHoliday("Labor Day", nthWeekday(year, 9, isoWeekday = 1, n = 1)),
    PetCareHoliday("Thanksgiving", nthWeekday(year, 11, isoWeekday = 4, n = 4)),
    PetCareHoliday("Christmas", LocalDate(year, 12, 25)),
)

data class HolidayRunway(
    val name: String,
    val dateIso: String,
    val daysUntil: Int,
    val bookedVisits: Int,
)

/**
 * The next [count] upcoming pet-care holidays (today counts as upcoming, and
 * the list rolls into next year), each with a days-until countdown and the
 * non-cancelled visits already booked inside the holiday window (+-2 days).
 */
fun holidayRunway(
    sessions: List<KinCareSession>,
    todayIso: String,
    count: Int = 3,
): List<HolidayRunway> {
    val today = parseDay(todayIso) ?: return emptyList()
    return (usPetCareHolidays(today.year) + usPetCareHolidays(today.year + 1))
        .filter { it.date >= today }
        .sortedBy { it.date }
        .take(count)
        .map { h ->
            val windowStart = h.date.plus(-2, DateTimeUnit.DAY)
            val windowEnd = h.date.plus(2, DateTimeUnit.DAY)
            val booked = sessions.count { s ->
                if (s.isCancelled()) return@count false
                val d = parseDay(s.startTime) ?: return@count false
                d in windowStart..windowEnd
            }
            HolidayRunway(
                name = h.name,
                dateIso = h.date.toString(),
                daysUntil = (h.date.toEpochDays() - today.toEpochDays()).toInt(),
                bookedVisits = booked,
            )
        }
}
