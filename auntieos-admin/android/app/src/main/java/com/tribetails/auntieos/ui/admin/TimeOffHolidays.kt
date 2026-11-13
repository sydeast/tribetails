package com.tribetails.auntieos.ui.admin

/**
 * The observed-holiday switch ids, each paired with the one-click preset in
 * [US_HOLIDAY_PRESETS] that names it. The ids are the stored
 * `observedUsHolidays` keys and stay as they are: only `columbus` differs from
 * its preset id.
 */
private val OBSERVED_HOLIDAY_PRESET_IDS = listOf(
    "new_years" to "new_years",
    "mlk" to "mlk",
    "presidents" to "presidents",
    "memorial" to "memorial",
    "juneteenth" to "juneteenth",
    "independence" to "independence",
    "labor" to "labor",
    "columbus" to "indigenous_columbus",
    "veterans" to "veterans",
    "thanksgiving" to "thanksgiving",
    "christmas" to "christmas",
)

/**
 * The eleven US holiday switches on the Time Off panel, id to name, in
 * calendar order. Each name is read off its quick-add preset, so a holiday has
 * one name on the whole panel (#1947). Mirrors `US_HOLIDAYS` in
 * `auntieos-admin/src/lib/settingsFormat.ts`.
 */
val US_OBSERVED_HOLIDAYS: List<Pair<String, String>> = OBSERVED_HOLIDAY_PRESET_IDS.map { (id, presetId) ->
    id to (US_HOLIDAY_PRESETS.firstOrNull { it.id == presetId }?.name ?: id)
}

/** One company holiday row as the Time Off list shows it. */
data class CompanyHolidayRow(
    /** The stored wire string, unchanged. */
    val entry: String,
    /** Its position in the stored `companyHolidays` list, so Remove takes out this entry and no other. */
    val index: Int,
    val closure: ClosureEntry,
    /** The next date it falls on, today or later; `null` for a one-time date that has passed or a row that cannot be read. */
    val next: String?,
)

/**
 * Company holidays in the order the Time Off list shows them (#1979): the
 * next closure first, by the date each row next falls on (a yearly row has no
 * stored year, so its date is its next occurrence from [todayIso]). After the
 * upcoming rows come one-time closures that have passed, oldest first, then
 * any row that cannot be read. Same date: by name, then stored position.
 * Display only: the stored list keeps its order, and each row carries its
 * stored [CompanyHolidayRow.index]. Mirrors `companyHolidayRows` in
 * `auntieos-admin/src/lib/settingsFormat.ts`.
 */
fun companyHolidayRows(entries: List<String>, todayIso: String): List<CompanyHolidayRow> {
    fun group(r: CompanyHolidayRow) = when {
        r.next != null -> 0
        r.closure.date.isNotEmpty() -> 1
        else -> 2
    }
    return entries
        .mapIndexed { index, entry ->
            val closure = parseClosureEntry(entry)
            CompanyHolidayRow(entry, index, closure, nextClosureOccurrence(closure, todayIso))
        }
        .sortedWith(
            compareBy<CompanyHolidayRow>({ group(it) }, { it.next ?: it.closure.date }, { it.closure.name }, { it.index }),
        )
}
