package com.tribetails.auntieos.web.screens.home

/**
 * 17.3 Dashboard customization (web/desktop). Pure model + transforms for the
 * operator-editable Home dashboard, persisted to UserProfile.dashboardWidgets as an
 * ordered list of "key:size" tokens. A known key absent from the list = hidden; an
 * empty list = the shipped default (so an un-customized dashboard reads byte-identical
 * to pre-17.3). STATS is the 4-card stat row treated as one always-full-width widget.
 * Free of Compose so it is unit-testable on the JVM; mirrored on android. See
 * [DashboardLayoutTest].
 */

enum class DashKey(val token: String) {
    STATS("stats"),
    TODAYS_PACK("todaysPack"),
    KINTALES("kintales"),
    CASH_FLOW("cashFlow"),
    GATEKEEPER("gatekeeper"),
    WEATHER_WATCHDOG("weatherWatchdog"),
    HEAT_INDEX("heatIndex"),
    // A8 insight widgets (W8-W13). All ship hidden by default: absent from
    // DEFAULT_DASHBOARD, offered under Customize > Hidden cards.
    WEEKLY_CAPACITY("weeklyCapacity"),
    OVERDUE_TRACKER("overdueTracker"),
    PET_BREAKDOWN("petBreakdown"),
    FREQUENT_FLYERS("frequentFlyers"),
    HOLIDAY_RUNWAY("holidayRunway"),
    // AO-38 / W6 Unread Client Messages. One-shot listConversations (not a
    // stream); hidden by default like the other insight widgets.
    UNREAD_MESSAGES("unreadMessages"),
    // AO-36 / W3 Key & Code Safebox. Joins sessions + kinfolk (both already
    // streamed on Home); hidden by default.
    SAFEBOX("safebox");

    companion object {
        fun parse(s: String?): DashKey? = entries.firstOrNull { it.token == s?.trim() }
    }
}

enum class DashSize(val token: String) {
    COMPACT("compact"),
    WIDE("wide");

    companion object {
        fun parse(s: String?): DashSize = entries.firstOrNull { it.token == s?.trim() } ?: COMPACT
    }
}

data class DashWidget(val key: DashKey, val size: DashSize)

/** The 4-stat row spans full width always; only it is forced wide. */
private fun normalize(key: DashKey, size: DashSize): DashSize =
    if (key == DashKey.STATS) DashSize.WIDE else size

/** Shipped default: stat row on top, the two panels compact so they pair side-by-side. */
val DEFAULT_DASHBOARD: List<DashWidget> = listOf(
    DashWidget(DashKey.STATS, DashSize.WIDE),
    DashWidget(DashKey.TODAYS_PACK, DashSize.COMPACT),
    DashWidget(DashKey.KINTALES, DashSize.COMPACT),
)

/** Parse "key:size" tokens: drop unknown keys, dedupe by key (first wins), force STATS wide. */
fun parseDashboard(tokens: List<String>): List<DashWidget> {
    val seen = mutableSetOf<DashKey>()
    val out = mutableListOf<DashWidget>()
    for (raw in tokens) {
        val parts = raw.split(":")
        val key = DashKey.parse(parts.getOrNull(0)) ?: continue
        if (!seen.add(key)) continue
        out.add(DashWidget(key, normalize(key, DashSize.parse(parts.getOrNull(1)))))
    }
    return out
}

/** Effective dashboard at load: saved layout, or the default when nothing is stored. */
fun resolvedDashboard(tokens: List<String>): List<DashWidget> =
    if (tokens.isEmpty()) DEFAULT_DASHBOARD else parseDashboard(tokens).ifEmpty { DEFAULT_DASHBOARD }

/** Serialize back to "key:size" tokens for saveUserProfile. */
fun List<DashWidget>.toTokens(): List<String> = map { "${it.key.token}:${it.size.token}" }

/** Known widgets not currently shown, in enum order (the "hidden" strip). */
fun hiddenKeys(shown: List<DashWidget>): List<DashKey> {
    val shownKeys = shown.map { it.key }.toSet()
    return DashKey.entries.filter { it !in shownKeys }
}

/**
 * Group the shown widgets into render rows: a WIDE widget is a solo full-width row;
 * consecutive COMPACT widgets pair two-to-a-row (a lone trailing compact is solo).
 */
fun packRows(shown: List<DashWidget>): List<List<DashWidget>> {
    val rows = mutableListOf<List<DashWidget>>()
    var i = 0
    while (i < shown.size) {
        val w = shown[i]
        val next = shown.getOrNull(i + 1)
        if (w.size == DashSize.COMPACT && next != null && next.size == DashSize.COMPACT) {
            rows.add(listOf(w, next)); i += 2
        } else {
            rows.add(listOf(w)); i += 1
        }
    }
    return rows
}

/** Adjacent swap up; no-op at the top. */
fun moveWidgetUp(list: List<DashWidget>, index: Int): List<DashWidget> {
    if (index <= 0 || index >= list.size) return list
    val out = list.toMutableList()
    out[index - 1] = list[index]
    out[index] = list[index - 1]
    return out
}

/** Adjacent swap down; no-op at the bottom. */
fun moveWidgetDown(list: List<DashWidget>, index: Int): List<DashWidget> {
    if (index < 0 || index >= list.size - 1) return list
    val out = list.toMutableList()
    out[index + 1] = list[index]
    out[index] = list[index + 1]
    return out
}

/** Set a widget's size (STATS stays wide). */
fun setWidgetSize(list: List<DashWidget>, key: DashKey, size: DashSize): List<DashWidget> =
    list.map { if (it.key == key) it.copy(size = normalize(key, size)) else it }

/** Hide a widget (remove from the shown list). */
fun hideWidget(list: List<DashWidget>, key: DashKey): List<DashWidget> =
    list.filterNot { it.key == key }

/** Show a previously hidden widget, appended at the end. */
fun showWidget(list: List<DashWidget>, key: DashKey, size: DashSize = DashSize.COMPACT): List<DashWidget> =
    if (list.any { it.key == key }) list else list + DashWidget(key, normalize(key, size))
