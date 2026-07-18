package com.tribetails.auntieos.ui.home

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.inbox.ConversationSummary
import java.time.LocalDate

/**
 * AO-24: android parity for the A8 dashboard insight widgets (Weekly capacity,
 * Overdue visits, Pets by type, Frequent flyers, Holiday runway). Ported from
 * web/.../screens/home/DashboardInsights.kt — same rules, translated from
 * kotlinx.datetime to java.time (android has no kotlinx.datetime). Compose-free
 * so every rule stays unit-testable; the composables live in HomeInsightWidgets.kt.
 */

private fun parseDay(s: String): LocalDate? =
    runCatching { LocalDate.parse(s.take(10)) }.getOrNull()

private fun LocalDate.mondayOfWeek(): LocalDate = minusDays((dayOfWeek.value - 1).toLong())

private val CANCELLED_STATUSES = setOf("CANCELLED", "CANCELED")

private fun KinCareSession.isCancelled(): Boolean = status.uppercase() in CANCELLED_STATUSES

// ── Weekly capacity ─────────────────────────────────────────────────────────

data class WeeklyCapacity(val booked: Int, val record: Int, val capacity: Int) {
    val fraction: Float get() = if (capacity <= 0) 0f else (booked.toFloat() / capacity).coerceIn(0f, 1f)
    val beatingRecord: Boolean get() = record in 1 until booked || (record == 0 && booked > 0)
}

fun weeklyCapacity(sessions: List<KinCareSession>, todayIso: String): WeeklyCapacity? {
    val today = parseDay(todayIso) ?: return null
    val monday = today.mondayOfWeek()
    fun weekCount(weekStart: LocalDate): Int {
        val weekEnd = weekStart.plusDays(7)
        return sessions.count { s ->
            if (s.isCancelled()) return@count false
            val d = parseDay(s.startTime) ?: return@count false
            d >= weekStart && d < weekEnd
        }
    }
    val booked = weekCount(monday)
    val record = (1..4).maxOf { weekCount(monday.minusDays((7 * it).toLong())) }
    return WeeklyCapacity(booked = booked, record = record, capacity = maxOf(record, booked, 1))
}

// ── Overdue visits ──────────────────────────────────────────────────────────

data class OverdueVisit(
    val sessionId: String,
    val kinfolkName: String,
    val serviceType: String,
    val endedAt: String,
)

fun overdueVisits(
    sessions: List<KinCareSession>,
    nowIso: String,
    withinDays: Int = 30,
): List<OverdueVisit> {
    parseDay(nowIso) ?: return emptyList()
    val staleBefore = parseDay(nowIso)!!.minusDays(withinDays.toLong())
    return sessions
        .mapNotNull { s ->
            val status = s.status.uppercase()
            if (status == "COMPLETED" || s.isCancelled()) return@mapNotNull null
            val end = s.endTime.ifBlank { s.startTime }
            val endDay = parseDay(end) ?: return@mapNotNull null
            // ISO strings compare lexicographically, so no clock math is needed.
            if (end >= nowIso || endDay < staleBefore) return@mapNotNull null
            OverdueVisit(
                sessionId = s.id,
                kinfolkName = s.kinfolkName.ifBlank { "Kinfolk" },
                serviceType = s.serviceType,
                endedAt = end,
            )
        }
        .sortedByDescending { it.endedAt }
}

// ── Pets by type ────────────────────────────────────────────────────────────

data class SpeciesSlice(val species: String, val count: Int)

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

// ── Frequent flyers ─────────────────────────────────────────────────────────

data class FrequentFlyer(val household: String, val visits: Int)

fun frequentFlyers(
    sessions: List<KinCareSession>,
    todayIso: String,
    days: Int = 90,
    limit: Int = 5,
): List<FrequentFlyer> {
    val today = parseDay(todayIso) ?: return emptyList()
    val since = today.minusDays(days.toLong())
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

// ── Holiday runway ──────────────────────────────────────────────────────────

data class PetCareHoliday(val name: String, val date: LocalDate)

private fun nthWeekday(year: Int, month: Int, isoWeekday: Int, n: Int): LocalDate {
    val first = LocalDate.of(year, month, 1)
    val offset = (isoWeekday - first.dayOfWeek.value + 7) % 7
    return first.plusDays((offset + 7 * (n - 1)).toLong())
}

private fun lastWeekday(year: Int, month: Int, lastDay: Int, isoWeekday: Int): LocalDate {
    val last = LocalDate.of(year, month, lastDay)
    return last.minusDays(((last.dayOfWeek.value - isoWeekday + 7) % 7).toLong())
}

fun usPetCareHolidays(year: Int): List<PetCareHoliday> = listOf(
    PetCareHoliday("New Year's Day", LocalDate.of(year, 1, 1)),
    PetCareHoliday("Memorial Day", lastWeekday(year, 5, 31, isoWeekday = 1)),
    PetCareHoliday("July 4th", LocalDate.of(year, 7, 4)),
    PetCareHoliday("Labor Day", nthWeekday(year, 9, isoWeekday = 1, n = 1)),
    PetCareHoliday("Thanksgiving", nthWeekday(year, 11, isoWeekday = 4, n = 4)),
    PetCareHoliday("Christmas", LocalDate.of(year, 12, 25)),
)

data class HolidayRunway(
    val name: String,
    val dateIso: String,
    val daysUntil: Int,
    val bookedVisits: Int,
)

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
            val windowStart = h.date.minusDays(2)
            val windowEnd = h.date.plusDays(2)
            val booked = sessions.count { s ->
                if (s.isCancelled()) return@count false
                val d = parseDay(s.startTime) ?: return@count false
                d in windowStart..windowEnd
            }
            HolidayRunway(
                name = h.name,
                dateIso = h.date.toString(),
                daysUntil = (h.date.toEpochDay() - today.toEpochDay()).toInt(),
                bookedVisits = booked,
            )
        }
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
 * "". Mirrors the web DashboardInsights.unreadClientMessages exactly.
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
 * compare) and whose state is neither cancelled nor completed. Mirrors web + React.
 */
fun nextUpcomingSession(sessions: List<KinCareSession>, nowIso: String): KinCareSession? =
    sessions.asSequence()
        .filter { !it.isCancelled() && it.status.uppercase() != "COMPLETED" }
        .filter { it.startTime.isNotBlank() && it.startTime >= nowIso }
        .minByOrNull { it.startTime }
data class AccessLine(val label: String, val value: String, val mono: Boolean = false)
/**
 * A household's access notes as display lines, blank fields dropped. Codes/
 * passwords flagged [mono]. Arrival order. Mirrors web + React safeboxAccessLines.
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
