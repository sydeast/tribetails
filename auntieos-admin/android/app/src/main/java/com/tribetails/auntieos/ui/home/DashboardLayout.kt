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
    HEAT_INDEX("heatIndex"),
    // AO-24: android parity for the A8 insight widgets. Tokens match the web
    // DashKey exactly so a layout customized on either app round-trips through
    // UserProfile.dashboardWidgets.
    WEEKLY_CAPACITY("weeklyCapacity"),
    OVERDUE_TRACKER("overdueTracker"),
    PET_BREAKDOWN("petBreakdown"),
    FREQUENT_FLYERS("frequentFlyers"),
    HOLIDAY_RUNWAY("holidayRunway"),
    // AO-38 / W6 Unread Client Messages. Token matches web exactly so a layout
    // round-trips through UserProfile.dashboardWidgets.
    UNREAD_MESSAGES("unreadMessages"),
    // AO-36 / W3 Key & Code Safebox. Token matches web.
    SAFEBOX("safebox"),
    // AO-37/39/35/40/41 dashboard widgets. Tokens match web + React exactly so a
    // layout customized on any surface round-trips through UserProfile.dashboardWidgets.
    // All hidden by default (not in DEFAULT_DASHBOARD).
    CARE_FLAGS("careFlags"),
    EXPIRATIONS("expirations"),
    ROUTE_OPTIMIZER("routeOptimizer"),
    EXPENSE_LOG("expenseLog"),
    SUPPLIES("supplies");

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

/**
 * Human label for a dashboard widget key, used by the edit chrome, the hidden
 * strip and every announcement below. It sits beside the model rather than in
 * HomeScreen so the announcements can name a card exactly the way the buttons
 * do. Copied from the React admin's DASH_LABELS verbatim (screens/Home.tsx), so
 * a key added to the model has to gain a label on both surfaces and both
 * surfaces then call the same card the same thing.
 */
fun dashLabel(key: DashKey): String = when (key) {
    DashKey.STATS -> "Stats"
    DashKey.TODAYS_PACK -> "Today's Pack"
    DashKey.KINTALES -> "KinTales"
    DashKey.CASH_FLOW -> "Cash Flow"
    DashKey.GATEKEEPER -> "Gatekeeper"
    DashKey.WEATHER_WATCHDOG -> "Weather Watchdog"
    DashKey.HEAT_INDEX -> "Heat Stroke Index"
    DashKey.WEEKLY_CAPACITY -> "Weekly capacity"
    DashKey.OVERDUE_TRACKER -> "Overdue visits"
    DashKey.PET_BREAKDOWN -> "Pets by type"
    DashKey.FREQUENT_FLYERS -> "Frequent flyers"
    DashKey.HOLIDAY_RUNWAY -> "Holiday runway"
    DashKey.UNREAD_MESSAGES -> "Unread messages"
    DashKey.SAFEBOX -> "Key & code safebox"
    DashKey.CARE_FLAGS -> "Care flags"
    DashKey.EXPIRATIONS -> "Expiration countdown"
    DashKey.ROUTE_OPTIMIZER -> "Route optimizer"
    DashKey.EXPENSE_LOG -> "Expense quick-log"
    DashKey.SUPPLIES -> "Supplies tracker"
}

/*
 * What a screen reader is told after a layout change.
 *
 * The edit controls always carried a contentDescription, but nothing narrated
 * the RESULT, so moving a card under TalkBack read as though the tap had done
 * nothing at all. These build the sentence Home announces through its live
 * region, and the wording matches the React admin's live-region strings word for
 * word (screens/Home.tsx), so an operator who uses both hears one product.
 *
 * Each takes the list AFTER the transform, because the position an operator
 * needs to hear is the one the card ended up in, not the one it left.
 *
 * There is deliberately no resize announcement: size is a wide-screen concern
 * and the phone edit bar has no resize control to announce.
 */

/**
 * Blank when [key] is not in [next], which means the move did not happen. A
 * bounds no-op must stay silent rather than announce a move to position 0.
 */
fun widgetMovedAnnouncement(next: List<DashWidget>, key: DashKey, movedUp: Boolean): String {
    val at = next.indexOfFirst { it.key == key }
    if (at < 0) return ""
    val direction = if (movedUp) "up" else "down"
    return "${dashLabel(key)} moved $direction to position ${at + 1} of ${next.size}."
}

fun widgetRemovedAnnouncement(key: DashKey): String = "${dashLabel(key)} removed from Home."

/** [next] is the list after the add, which appends, so the card is last. */
fun widgetAddedAnnouncement(next: List<DashWidget>, key: DashKey): String =
    "${dashLabel(key)} added to Home at position ${next.size} of ${next.size}."
