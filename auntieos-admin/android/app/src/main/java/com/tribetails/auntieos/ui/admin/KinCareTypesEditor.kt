package com.tribetails.auntieos.ui.admin

/**
 * The pure half of the KinCare types editor: rows in, maps out, and the view
 * order in between. Mirrors `KinCareRatesEditor.tsx` (auntieos-admin
 * src/screens/settings) rule for rule, so a rate card edited on the phone
 * folds to the same document the web editor writes.
 *
 * ISSUE #755 (the `auntieos-kincare-types` mock) is the first time the phone
 * can edit this at all. `business_settings.serviceRates` and
 * `serviceDurations` were decoded ([BusinessSettings]), diffed
 * ([businessSettingsFieldChanges]) and read by the schedule, the booking
 * wizard and the package builder, and no Android surface could change them.
 *
 * THREE COLUMNS. Mark 15 of the 2026-08-17 walk: a KinCare type has a
 * name/title, a duration and a price. `serviceRates` stays name -> rate, the
 * shape every reader has; durations go in the parallel `serviceDurations`,
 * keyed by the same name, and a blank duration writes NO key at all so the
 * name-parse fallback ([serviceDurationMinutes]) keeps running for that type.
 *
 * ROW IDENTITY IS NOT THE MAP KEY. A type name IS the key it is stored under,
 * so editing it in place needs an identity independent of the key that might
 * be mid-edit: the row's position in the list. Sorting is a VIEW over those
 * positions ([sortedKinCareView]) and never reorders what gets saved.
 */
data class KinCareTypeRow(
    val type: String,
    val duration: String,
    val rate: String,
) {
    companion object {
        val BLANK = KinCareTypeRow(type = "", duration = "", rate = "")
    }
}

/** How the table is ordered on screen. Never how it is stored. */
enum class KinCareSortKey(val label: String) {
    STORED("As saved"),
    NAME("Name"),
    DURATION("Duration"),
    RATE("Rate"),
}

/** One row per stored rate, in stored order, with its duration beside it when one is stored. */
fun kinCareRows(
    rates: Map<String, String>,
    durations: Map<String, String>,
): List<KinCareTypeRow> =
    rates.entries.map { (type, rate) ->
        KinCareTypeRow(type = type, duration = durations[type].orEmpty(), rate = rate)
    }

/**
 * Rows to the rate map: blank-name rows dropped, last row wins on a duplicate
 * (the wasm editor's `associate`), every value trimmed.
 */
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
 * Rows to the duration map, on the same rules and one more: a blank duration
 * writes no key. The map is meant to be sparse; an empty string there would be
 * a stored statement that the operator gave a length, which is exactly what
 * did not happen.
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
 * Rate as a number for sorting. Unset or unparseable sorts LAST. The blank
 * check is not redundant: without it a priceless row would sort as free.
 */
fun kinCareRateRank(raw: String): Double {
    val trimmed = raw.trim().removePrefix("$")
    if (trimmed.isEmpty()) return Double.MAX_VALUE
    val n = trimmed.toDoubleOrNull() ?: return Double.MAX_VALUE
    return if (n.isFinite()) n else Double.MAX_VALUE
}

/** The minutes a row runs for: what the operator typed, else what the name states, else nothing. */
fun kinCareRowMinutes(row: KinCareTypeRow): Int? =
    storedDurationMinutes(row.duration) ?: serviceDurationMinutes(row.type)

/**
 * The table in display order, each row tagged with its STORED index so an
 * edit aimed at the third row on screen lands on the row it came from.
 * `sortedBy` is stable, so ties keep the order they were saved in.
 */
fun sortedKinCareView(rows: List<KinCareTypeRow>, key: KinCareSortKey): List<IndexedValue<KinCareTypeRow>> {
    val tagged = rows.withIndex().toList()
    return when (key) {
        KinCareSortKey.STORED -> tagged
        KinCareSortKey.NAME -> tagged.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.value.type.trim() })
        KinCareSortKey.RATE -> tagged.sortedBy { kinCareRateRank(it.value.rate) }
        KinCareSortKey.DURATION -> tagged.sortedBy { kinCareRowMinutes(it.value) ?: Int.MAX_VALUE }
    }
}

/**
 * The duration field's placeholder: what the name implies, shown greyed and
 * never written unless the operator types it. Matches the web placeholder.
 */
fun kinCareDurationPlaceholder(row: KinCareTypeRow): String {
    if (row.duration.isNotBlank()) return ""
    val implied = serviceDurationMinutes(row.type) ?: return "Not set"
    return "$implied (from the name)"
}

/** The booking wizard's own label for a row, the preview panel's chip text. */
fun kinCarePreviewLabel(row: KinCareTypeRow): String =
    serviceChipLabel(
        ServiceOption(
            name = row.type.trim().ifEmpty { "Untitled" },
            rate = row.rate.trim(),
            durationMinutes = kinCareRowMinutes(row),
        ),
    )

/** "1 type" / "3 types", the rows panel's detail line. */
fun kinCareTypeCount(count: Int): String = if (count == 1) "1 type" else "$count types"
