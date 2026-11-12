package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.model.BusinessSettings

// ─────────────────────────────────────────────────────────────────────────────
// The weekly hours, read from and written to `business_settings.businessHours`.
// Pure, so every decision here is JVM-testable.
//
// #1764: that map is the one store. The admin web (BusinessHoursEditor.tsx),
// the desktop console (SettingsScreen.kt BusinessHoursPanel), the phone line
// (`resolveBusinessOpen`) and the booking checks (`weeklyHoursRule.ts`) all read
// it. Android used to edit a separate `business_hours` collection that nothing
// else read, and seeded it with Mon-Fri 09:00-17:00 on an empty read. It reads
// and writes the map now, through the same `saveBusinessSettings` save.
//
// THE MAP. Keys are Monday-first full day names, exactly as [WEEK_DAY_NAMES]
// spells them. A value is "HH:MM-HH:MM", or "" for Closed. A day with no key
// is NOT SET: the server reads that as "cannot tell", not as Closed, so this
// file never turns one into Closed or into invented hours.
//
// #1978, THE HOURS A CLOSED DAY HAD. "" has no room for them, so the save
// keeps them beside the map, in `business_settings.closedDayHours` (the server
// writes it, see `closedDayHoursChanges` in businessSettingsChecks.ts). A
// Closed row carries that range in its two times, hidden while it is closed,
// so switching the day back on shows the hours it had. A day with nothing kept
// reopens with both times empty and the "Enter both..." sentence under it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The map's keys, Monday first. `WEEK_DAY_NAMES[dayOfWeek - 1]` names a day,
 * where `dayOfWeek` 1 = Monday .. 7 = Sunday, the [BusinessHours] convention
 * and `java.time.DayOfWeek.value`.
 */
val WEEK_DAY_NAMES = listOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

private val TIME_REGEX = Regex("""^([01]\d|2[0-3]):([0-5]\d)$""")

internal fun parseTimeOrNull(s: String): Pair<Int, Int>? {
    val m = TIME_REGEX.matchEntire(s) ?: return null
    return m.groupValues[1].toInt() to m.groupValues[2].toInt()
}

internal fun formatHoursDisplay(h: BusinessHours): String =
    if (h.isOpen) "${h.openTime}-${h.closeTime}" else "Closed"

/** What one day's stored value says. */
enum class DayHoursKind { NOT_SET, CLOSED, OPEN }

/**
 * One day as an editor shows it.
 *
 * [openTime] and [closeTime] are what the two fields hold. A stored value the
 * parser cannot read keeps its own text in them (split at the dash), so the
 * operator sees what is stored and [problem] says what is wrong with it. It is
 * never shown as Closed or as a default range.
 *
 * #1978: a Closed row keeps the hours the day had in the same two fields, so
 * `copy(kind = OPEN)` gives them back. They are not written while it is
 * closed: [wireValue] is "" whatever they hold.
 */
data class WeeklyHoursRow(
    val dayOfWeek: Int,
    val kind: DayHoursKind,
    val openTime: String = "",
    val closeTime: String = "",
) {
    val dayName: String get() = WEEK_DAY_NAMES[dayOfWeek - 1]
    val isOpen: Boolean get() = kind == DayHoursKind.OPEN

    /** The server's sentence for this row, or null when it saves. */
    val problem: String? get() = if (isOpen) businessHoursRowProblem(openTime, closeTime) else null

    /**
     * The value this row writes: "HH:MM-HH:MM" with two-digit hours, "" for
     * Closed, null for Not set (a day nobody has set has no key to write).
     * Null too for an open row with a [problem]: there is nothing valid to send.
     */
    val wireValue: String?
        get() = when (kind) {
            DayHoursKind.NOT_SET -> null
            DayHoursKind.CLOSED -> ""
            DayHoursKind.OPEN -> normalizedHoursRange(openTime, closeTime)
        }

    /** The text a read-only list shows for the day. */
    val display: String
        get() = when (kind) {
            DayHoursKind.NOT_SET -> "Not set"
            DayHoursKind.CLOSED -> "Closed"
            DayHoursKind.OPEN -> wireValue ?: listOf(openTime, closeTime).filter { it.isNotBlank() }.joinToString("-")
        }
}

/** `open`-`close` as the map stores it, two-digit hours. Null when the pair does not save. */
internal fun normalizedHoursRange(open: String, close: String): String? {
    if (businessHoursRowProblem(open, close) != null) return null
    return "${hhmm(open)}-${hhmm(close)}"
}

/**
 * One stored value as a row. [kept] is the day's entry in `closedDayHours`:
 * a Closed row carries it in its two times when it is a readable range, and
 * empty times otherwise (never a default).
 */
internal fun weeklyHoursRowOf(dayOfWeek: Int, stored: String?, kept: String? = null): WeeklyHoursRow {
    if (stored == null) return WeeklyHoursRow(dayOfWeek, DayHoursKind.NOT_SET)
    val raw = stored.trim()
    if (raw.isEmpty()) {
        val had = readableRangeOrNull(kept) ?: return WeeklyHoursRow(dayOfWeek, DayHoursKind.CLOSED)
        return WeeklyHoursRow(dayOfWeek, DayHoursKind.CLOSED, openTime = had.first, closeTime = had.second)
    }
    val parts = raw.split("-")
    if (parts.size != 2) return WeeklyHoursRow(dayOfWeek, DayHoursKind.OPEN, openTime = raw, closeTime = "")
    val open = parts[0].trim()
    val close = parts[1].trim()
    // A readable value shows padded ("9:00" reads as "09:00"); anything else as stored.
    return WeeklyHoursRow(
        dayOfWeek,
        DayHoursKind.OPEN,
        openTime = hhmm(open) ?: open,
        closeTime = hhmm(close) ?: close,
    )
}

/** The two times of a stored range the server's rule accepts, two-digit hours, or null. */
private fun readableRangeOrNull(stored: String?): Pair<String, String>? {
    val parts = stored?.trim()?.split("-") ?: return null
    if (parts.size != 2) return null
    val range = normalizedHoursRange(parts[0].trim(), parts[1].trim()) ?: return null
    return range.substringBefore("-") to range.substringAfter("-")
}

/**
 * The seven days of [map], Monday first. Keys other than [WEEK_DAY_NAMES] are
 * not days and are ignored. [kept] is `closedDayHours` (#1978).
 */
fun weeklyHoursRows(map: Map<String, String>, kept: Map<String, String> = emptyMap()): List<WeeklyHoursRow> =
    WEEK_DAY_NAMES.mapIndexed { index, day -> weeklyHoursRowOf(index + 1, map[day], kept[day]) }

/** The week of [settings] as the editors show it: the hours map, with each Closed day's kept hours. */
fun weeklyHoursRows(settings: BusinessSettings): List<WeeklyHoursRow> =
    weeklyHoursRows(settings.businessHours, settings.closedDayHours)

/** True when no day of [rows] has been set, the state of a business that never saved hours. */
fun noWeeklyHoursSet(rows: List<WeeklyHoursRow>): Boolean = rows.all { it.kind == DayHoursKind.NOT_SET }

/**
 * The days [rows] change relative to [stored], keyed by day name, each with
 * the value to write. A day that reads the same as it is stored is left out,
 * so an untouched day keeps its exact stored text ("9:00-17:00" is not
 * rewritten as "09:00-17:00" by a save of Tuesday). A Not set row writes
 * nothing. An open row with a problem writes nothing either; the editors keep
 * Save off while one shows, so this never quietly drops an edit.
 */
fun weeklyHoursPatch(stored: Map<String, String>, rows: List<WeeklyHoursRow>): Map<String, String> {
    val patch = LinkedHashMap<String, String>()
    for (row in rows) {
        val value = row.wireValue ?: continue
        if (weeklyHoursRowOf(row.dayOfWeek, stored[row.dayName]).wireValue == value) continue
        patch[row.dayName] = value
    }
    return patch
}

/** [stored] with [rows]' changed days written over it, the map the server holds after the save. */
fun withWeeklyHours(stored: Map<String, String>, rows: List<WeeklyHoursRow>): Map<String, String> =
    stored + weeklyHoursPatch(stored, rows)

/**
 * #1978: `closedDayHours` after a save of [sent] over [storedHours], by the
 * rule the server applies (`closedDayHoursChanges`): a day saved as Closed
 * keeps the readable range it had stored, and a day saved with hours drops
 * what was kept for it. The server writes the field; this keeps the copy a
 * screen holds the same until its next load.
 */
fun closedDayHoursAfterSave(
    storedHours: Map<String, String>,
    kept: Map<String, String>,
    sent: Map<String, String>,
): Map<String, String> {
    val next = LinkedHashMap(kept)
    for ((day, value) in sent) {
        if (value.isNotBlank()) {
            next.remove(day)
            continue
        }
        val was = storedHours[day]?.trim().orEmpty()
        if (readableRangeOrNull(was) != null) next[day] = was
    }
    return next
}

/**
 * [this] as the server holds it once [rows]' changed days are saved: the hours
 * map with those days written, and `closedDayHours` moved by the same save.
 * [stored] is the map the changes are measured against.
 */
fun BusinessSettings.withWeeklyHoursSaved(stored: Map<String, String>, rows: List<WeeklyHoursRow>): BusinessSettings {
    val patch = weeklyHoursPatch(stored, rows)
    return copy(
        businessHours = businessHours + patch,
        closedDayHours = closedDayHoursAfterSave(stored, closedDayHours, patch),
    )
}

/** [this] with [row] in place of the row for the same day. */
fun List<WeeklyHoursRow>.withRow(row: WeeklyHoursRow): List<WeeklyHoursRow> =
    map { if (it.dayOfWeek == row.dayOfWeek) row else it }

/**
 * The days of [map] that say open or closed, as [BusinessHours] rows. A day
 * that is not set, or whose value cannot be read, has no row: a reader that
 * asks about it gets "nothing known", never a guess.
 */
fun businessHoursOf(map: Map<String, String>): List<BusinessHours> =
    weeklyHoursRows(map).mapNotNull { row ->
        when (row.kind) {
            DayHoursKind.NOT_SET -> null
            DayHoursKind.CLOSED -> BusinessHours(dayOfWeek = row.dayOfWeek, isOpen = false, openTime = "", closeTime = "")
            DayHoursKind.OPEN -> if (row.problem != null) null else BusinessHours(
                dayOfWeek = row.dayOfWeek,
                isOpen = true,
                openTime = row.openTime,
                closeTime = row.closeTime,
            )
        }
    }

/** [hours] as map entries: "HH:MM-HH:MM" for an open day, "" for a closed one. Rows that do not save are left out. */
fun businessHoursMapOf(hours: List<BusinessHours>): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (h in hours.sortedBy { it.dayOfWeek }) {
        if (h.dayOfWeek !in 1..7) continue
        val value = if (h.isOpen) normalizedHoursRange(h.openTime, h.closeTime) ?: continue else ""
        out[WEEK_DAY_NAMES[h.dayOfWeek - 1]] = value
    }
    return out
}

/**
 * The day and sentence of a `saveBusinessSettings` refusal on the weekly
 * hours. The server names the day first (`"Monday: <sentence>"`), so the
 * editor can put the sentence beside that day's row.
 */
fun weeklyHoursRefusal(refusal: SettingsRefusal?): Pair<Int, String>? {
    if (refusal == null || refusal.field != "businessHours") return null
    val index = WEEK_DAY_NAMES.indexOfFirst { refusal.message.startsWith("$it: ") }
    if (index < 0) return null
    return (index + 1) to refusal.message.substring(WEEK_DAY_NAMES[index].length + 2)
}
