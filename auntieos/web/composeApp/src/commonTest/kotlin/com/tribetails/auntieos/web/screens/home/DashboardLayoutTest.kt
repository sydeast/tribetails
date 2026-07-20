package com.tribetails.auntieos.web.screens.home

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 17.3 Dashboard customization pure-helper tests (web/desktop). Mirror of android.
 * Covers: blank -> default (zero regression), parse (drop unknown/dupes, STATS forced
 * wide), serialize round-trip, hidden = known minus shown, row packing (wide solo,
 * compacts pair), reorder, resize, hide/show.
 */
class DashboardLayoutTest {

    @Test
    fun empty_tokens_resolve_to_default_layout() {
        assertEquals(DEFAULT_DASHBOARD, resolvedDashboard(emptyList()))
        // default = stats(wide) then the two panels (compact, so they pair side-by-side)
        assertEquals(
            listOf(
                DashWidget(DashKey.STATS, DashSize.WIDE),
                DashWidget(DashKey.TODAYS_PACK, DashSize.COMPACT),
                DashWidget(DashKey.KINTALES, DashSize.COMPACT),
            ),
            resolvedDashboard(emptyList()),
        )
    }

    @Test
    fun parse_reads_key_and_size_tokens() {
        val r = parseDashboard(listOf("kintales:wide", "todaysPack:compact"))
        assertEquals(
            listOf(
                DashWidget(DashKey.KINTALES, DashSize.WIDE),
                DashWidget(DashKey.TODAYS_PACK, DashSize.COMPACT),
            ),
            r,
        )
    }

    @Test
    fun parse_drops_unknown_keys_and_dedupes_first_wins() {
        val r = parseDashboard(listOf("bogus:wide", "kintales:compact", "kintales:wide"))
        assertEquals(listOf(DashWidget(DashKey.KINTALES, DashSize.COMPACT)), r)
    }

    @Test
    fun parse_forces_stats_to_wide() {
        // STATS is the 4-card stat row; it always spans full width.
        assertEquals(
            listOf(DashWidget(DashKey.STATS, DashSize.WIDE)),
            parseDashboard(listOf("stats:compact")),
        )
    }

    @Test
    fun parse_unknown_size_falls_back_to_compact() {
        assertEquals(
            listOf(DashWidget(DashKey.KINTALES, DashSize.COMPACT)),
            parseDashboard(listOf("kintales:huge")),
        )
    }

    @Test
    fun toTokens_round_trips_through_parse() {
        val widgets = listOf(
            DashWidget(DashKey.TODAYS_PACK, DashSize.WIDE),
            DashWidget(DashKey.KINTALES, DashSize.COMPACT),
        )
        assertEquals(widgets, parseDashboard(widgets.toTokens()))
    }

    @Test
    fun hiddenKeys_is_known_minus_shown_in_enum_order() {
        val shown = listOf(DashWidget(DashKey.KINTALES, DashSize.COMPACT))
        assertEquals(
            listOf(
                DashKey.STATS, DashKey.TODAYS_PACK, DashKey.CASH_FLOW, DashKey.GATEKEEPER,
                DashKey.WEATHER_WATCHDOG, DashKey.HEAT_INDEX, DashKey.WEEKLY_CAPACITY,
                DashKey.OVERDUE_TRACKER, DashKey.PET_BREAKDOWN, DashKey.FREQUENT_FLYERS,
                DashKey.HOLIDAY_RUNWAY, DashKey.UNREAD_MESSAGES, DashKey.SAFEBOX,
                DashKey.CARE_FLAGS, DashKey.EXPIRATIONS, DashKey.ROUTE_OPTIMIZER,
                DashKey.EXPENSE_LOG, DashKey.SUPPLIES,
            ),
            hiddenKeys(shown),
        )
    }

    @Test
    fun packRows_wide_is_solo_compacts_pair() {
        val rows = packRows(DEFAULT_DASHBOARD)
        assertEquals(2, rows.size)
        assertEquals(listOf(DashWidget(DashKey.STATS, DashSize.WIDE)), rows[0])
        assertEquals(
            listOf(
                DashWidget(DashKey.TODAYS_PACK, DashSize.COMPACT),
                DashWidget(DashKey.KINTALES, DashSize.COMPACT),
            ),
            rows[1],
        )
    }

    @Test
    fun packRows_trailing_lone_compact_is_solo() {
        val shown = listOf(
            DashWidget(DashKey.TODAYS_PACK, DashSize.COMPACT),
            DashWidget(DashKey.KINTALES, DashSize.COMPACT),
            DashWidget(DashKey.STATS, DashSize.WIDE),
        )
        val rows = packRows(shown)
        assertEquals(2, rows.size)
        assertEquals(2, rows[0].size) // the two compacts pair
        assertEquals(1, rows[1].size) // stats wide solo
    }

    @Test
    fun moveWidgetDown_then_up_restores_order() {
        val moved = moveWidgetDown(DEFAULT_DASHBOARD, 0)
        assertEquals(DashKey.TODAYS_PACK, moved[0].key)
        assertEquals(DashKey.STATS, moved[1].key)
        assertEquals(DEFAULT_DASHBOARD, moveWidgetUp(moved, 1))
    }

    @Test
    fun moveWidget_at_bounds_is_noop() {
        assertEquals(DEFAULT_DASHBOARD, moveWidgetUp(DEFAULT_DASHBOARD, 0))
        assertEquals(DEFAULT_DASHBOARD, moveWidgetDown(DEFAULT_DASHBOARD, DEFAULT_DASHBOARD.lastIndex))
    }

    @Test
    fun setWidgetSize_changes_only_target_and_keeps_stats_wide() {
        val sized = setWidgetSize(DEFAULT_DASHBOARD, DashKey.TODAYS_PACK, DashSize.WIDE)
        assertEquals(DashSize.WIDE, sized.first { it.key == DashKey.TODAYS_PACK }.size)
        // STATS cannot become compact
        val stats = setWidgetSize(DEFAULT_DASHBOARD, DashKey.STATS, DashSize.COMPACT)
        assertEquals(DashSize.WIDE, stats.first { it.key == DashKey.STATS }.size)
    }

    @Test
    fun hide_then_show_round_trips() {
        val hidden = hideWidget(DEFAULT_DASHBOARD, DashKey.KINTALES)
        assertTrue(hidden.none { it.key == DashKey.KINTALES })
        val shown = showWidget(hidden, DashKey.KINTALES)
        assertTrue(shown.any { it.key == DashKey.KINTALES })
        assertEquals(DashKey.KINTALES, shown.last().key) // re-shown appended at the end
    }
}
