package com.tribetails.auntieos.ui.home

/**
 * 17.3 Dashboard customization (android). Pure model + transforms for the
 * operator-editable Home dashboard, persisted to UserProfile.dashboardWidgets as an
 * ordered list of "key:size" tokens. A known key absent = hidden; an empty list = the
 * shipped default (un-customized dashboard reads byte-identical to pre-17.3). STATS is
 * the stat row treated as one always-full-width widget. Mirror of the web
 * DashboardLayout.kt. See DashboardLayoutTest.
 */

enum class DashKey(val token: String) {
    STATS("stats"),
    TODAYS_PACK("todaysPack"),
    KINTALES("kintales"),
    CASH_FLOW("cashFlow"),
    GATEKEEPER("gatekeeper"),
    WEATHER_WATCHDOG("weatherWatchdog"),
    HEAT_INDEX("heatIndex");

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

private fun normalize(key: DashKey, size: DashSize): DashSize =
    if (key == DashKey.STATS) DashSize.WIDE else size

val DEFAULT_DASHBOARD: List<DashWidget> = listOf(
    DashWidget(DashKey.STATS, DashSize.WIDE),
    DashWidget(DashKey.TODAYS_PACK, DashSize.COMPACT),
    DashWidget(DashKey.KINTALES, DashSize.COMPACT),
)

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

fun resolvedDashboard(tokens: List<String>): List<DashWidget> =
    if (tokens.isEmpty()) DEFAULT_DASHBOARD else parseDashboard(tokens).ifEmpty { DEFAULT_DASHBOARD }

fun List<DashWidget>.toTokens(): List<String> = map { "${it.key.token}:${it.size.token}" }

fun hiddenKeys(shown: List<DashWidget>): List<DashKey> {
    val shownKeys = shown.map { it.key }.toSet()
    return DashKey.entries.filter { it !in shownKeys }
}

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

fun moveWidgetUp(list: List<DashWidget>, index: Int): List<DashWidget> {
    if (index <= 0 || index >= list.size) return list
    val out = list.toMutableList()
    out[index - 1] = list[index]
    out[index] = list[index - 1]
    return out
}

fun moveWidgetDown(list: List<DashWidget>, index: Int): List<DashWidget> {
    if (index < 0 || index >= list.size - 1) return list
    val out = list.toMutableList()
    out[index + 1] = list[index]
    out[index] = list[index + 1]
    return out
}

fun setWidgetSize(list: List<DashWidget>, key: DashKey, size: DashSize): List<DashWidget> =
    list.map { if (it.key == key) it.copy(size = normalize(key, size)) else it }

fun hideWidget(list: List<DashWidget>, key: DashKey): List<DashWidget> =
    list.filterNot { it.key == key }

fun showWidget(list: List<DashWidget>, key: DashKey, size: DashSize = DashSize.COMPACT): List<DashWidget> =
    if (list.any { it.key == key }) list else list + DashWidget(key, normalize(key, size))
