package com.tribetails.auntieos.web.screens.settings
import com.tribetails.auntieos.web.data.BusinessSettings
import kotlin.math.roundToInt
/**
 * The pure half of the KinCare types panel: rows in, maps out. Mirrors admin
 * web's `KinCareRatesEditor.tsx` and Android's `KinCareTypesEditor.kt` rule for
 * rule, so a rate card edited on this console folds to the document the other
 * two write (issue #1095).
 *
 * THREE MAPS, ONE ROW. `serviceRates` is name -> rate, `serviceDurations` is
 * name -> minutes (a blank length writes NO key, so the name-parse fallback keeps
 * running for that type) and `serviceStartTimeBooking` is name -> true, flagged
 * rows only. All three fold from the same rows in one save, so a rename carries
 * the length and the flag and can never leave the maps disagreeing.
 *
 * WRITTEN WHOLE. The console's settings save diffs top-level fields and masks
 * each one, so a changed map replaces the stored map: a cleared flag or a
 * renamed KinCare removes its old key instead of leaving it behind.
 */
data class KinCareTypeRow(
    val type: String,
    val duration: String = "",
    val rate: String = "",
    val startTime: Boolean = false,
)
/** The switch's label on every row. Issue #1098 renamed it on all three clients. */
const val KIN_CARE_START_TIME_LABEL = "You set the start time"
/** The switch's tooltip. A tooltip, not a subtitle: the 2026-09-11 ruling. */
const val KIN_CARE_START_TIME_TIP =
    "Kinfolk ask for the night. You set the start time when you approve the request. Use it for overnights."
/** One row per stored rate, in stored order, with its length and flag beside it when stored. */
fun kinCareRows(
    rates: Map<String, String>,
    durations: Map<String, String>,
    startTimes: Map<String, Boolean>,
): List<KinCareTypeRow> =
    rates.entries.map { (type, rate) ->
        KinCareTypeRow(
            type = type,
            duration = durations[type].orEmpty(),
            rate = rate,
            startTime = startTimes[type] == true,
        )
    }
/** Rows to the rate map: blank-name rows dropped, last row wins on a duplicate, values trimmed. */
fun foldKinCareRates(rows: List<KinCareTypeRow>): Map<String, String> {
    val edited = LinkedHashMap<String, String>()
    for (row in rows) {
        val type = row.type.trim()
        if (type.isEmpty()) continue
        edited[type] = row.rate.trim()
    }
    return edited
}
/**
 * Rows to the length map, on the same rules and one more: a blank length writes
 * no key. An empty string there would be a stored statement that the operator
 * gave a length, and it would stop the name-parse fallback from running.
 */
fun foldKinCareDurations(rows: List<KinCareTypeRow>): Map<String, String> {
    val edited = LinkedHashMap<String, String>()
    for (row in rows) {
        val type = row.type.trim()
        val duration = row.duration.trim()
        if (type.isEmpty() || duration.isEmpty()) continue
        edited[type] = duration
    }
    return edited
}
/**
 * Rows to the start-time map: flagged rows only, always `true`, on the same
 * blank-name and last-row-wins rules, so an unflagged duplicate after a flagged
 * one removes the key just as it would replace the rate.
 */
fun foldKinCareStartTime(rows: List<KinCareTypeRow>): Map<String, Boolean> {
    val edited = LinkedHashMap<String, Boolean>()
    for (row in rows) {
        val type = row.type.trim()
        if (type.isEmpty()) continue
        if (row.startTime) edited[type] = true else edited.remove(type)
    }
    return edited
}
private val NAME_DURATION_RE =
    Regex("""(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)""", RegexOption.IGNORE_CASE)
/**
 * Minutes a service name states: "45Minute" is 45, "1Hr" is 60, "Half-Day 6Hrs"
 * is 360. The largest match wins. Null when nothing parses.
 */
fun kinCareNameMinutes(name: String): Int? =
    NAME_DURATION_RE.findAll(name)
        .mapNotNull { m ->
            val n = m.groupValues[1].toIntOrNull() ?: return@mapNotNull null
            if (m.groupValues[2].startsWith("h", ignoreCase = true)) n * 60 else n
        }
        .maxOrNull()
/** A typed length as minutes. Null for blank, junk, zero or negative, so junk falls through to the name. */
fun kinCareTypedMinutes(raw: String): Int? {
    val n = raw.trim().toDoubleOrNull() ?: return null
    if (!n.isFinite() || n <= 0) return null
    return n.roundToInt()
}
/** The minutes a row runs for: what the operator typed, else what the name states, else nothing. */
fun kinCareRowMinutes(row: KinCareTypeRow): Int? =
    kinCareTypedMinutes(row.duration) ?: kinCareNameMinutes(row.type)
/**
 * The name of the first flagged row the server could not give an end to (no
 * length typed, none in the name), or null when every flagged row has one.
 */
fun kinCareStartTimeMissingLength(rows: List<KinCareTypeRow>): String? =
    rows.firstOrNull { it.startTime && it.type.isNotBlank() && kinCareRowMinutes(it) == null }
        ?.type?.trim()
/** The refusal Save shows for [kinCareStartTimeMissingLength]. */
fun kinCareNeedsLengthMessage(type: String): String =
    "\"$type\" needs a length so its end time can be worked out."
/** The length field's placeholder: what the name implies, never written unless typed. */
fun kinCareDurationPlaceholder(row: KinCareTypeRow): String {
    if (row.duration.isNotBlank()) return ""
    val implied = kinCareNameMinutes(row.type) ?: return "Not set"
    return "$implied (from the name)"
}
/** True when the rows differ from what [settings] holds. Stored `false` flags count as absent. */
fun kinCareRowsDirty(settings: BusinessSettings, rows: List<KinCareTypeRow>): Boolean =
    foldKinCareRates(rows) != settings.serviceRates ||
        foldKinCareDurations(rows) != settings.serviceDurations ||
        foldKinCareStartTime(rows) != settings.serviceStartTimeBooking.filterValues { it }
/** [settings] with the three maps replaced by what [rows] fold to. Nothing else changes. */
fun kinCareRowsApplied(settings: BusinessSettings, rows: List<KinCareTypeRow>): BusinessSettings =
    settings.copy(
        serviceRates = foldKinCareRates(rows),
        serviceDurations = foldKinCareDurations(rows),
        serviceStartTimeBooking = foldKinCareStartTime(rows),
    )
