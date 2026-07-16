package com.tribetails.auntieos.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 17.3 Dashboard customization pure-helper tests (android). Mirror of web. */
class DashboardLayoutTest {

    @Test
    fun empty_tokens_resolve_to_default_layout() {
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
    fun parse_reads_tokens_drops_unknown_dedupes_first_wins() {
        val r = parseDashboard(listOf("bogus:wide", "kintales:compact", "kintales:wide"))
        assertEquals(listOf(DashWidget(DashKey.KINTALES, DashSize.COMPACT)), r)
    }

    @Test
    fun parse_forces_stats_wide_and_unknown_size_compact() {
        assertEquals(listOf(DashWidget(DashKey.STATS, DashSize.WIDE)), parseDashboard(listOf("stats:compact")))
        assertEquals(listOf(DashWidget(DashKey.KINTALES, DashSize.COMPACT)), parseDashboard(listOf("kintales:huge")))
    }

    @Test
    fun toTokens_round_trips() {
        val w = listOf(DashWidget(DashKey.TODAYS_PACK, DashSize.WIDE), DashWidget(DashKey.KINTALES, DashSize.COMPACT))
        assertEquals(w, parseDashboard(w.toTokens()))
    }

    @Test
    fun hiddenKeys_is_known_minus_shown_in_enum_order() {
        assertEquals(
            listOf(
                DashKey.STATS, DashKey.TODAYS_PACK, DashKey.CASH_FLOW, DashKey.GATEKEEPER,
                DashKey.WEATHER_WATCHDOG, DashKey.HEAT_INDEX,
            ),
            hiddenKeys(listOf(DashWidget(DashKey.KINTALES, DashSize.COMPACT))),
        )
    }

    @Test
    fun packRows_wide_solo_compacts_pair() {
        val rows = packRows(DEFAULT_DASHBOARD)
        assertEquals(2, rows.size)
        assertEquals(1, rows[0].size)
        assertEquals(2, rows[1].size)
    }

    @Test
    fun packRows_trailing_lone_compact_solo() {
        val shown = listOf(
            DashWidget(DashKey.TODAYS_PACK, DashSize.COMPACT),
            DashWidget(DashKey.KINTALES, DashSize.COMPACT),
            DashWidget(DashKey.STATS, DashSize.WIDE),
        )
        val rows = packRows(shown)
        assertEquals(2, rows[0].size)
        assertEquals(1, rows[1].size)
    }

    @Test
    fun move_down_then_up_restores_and_bounds_noop() {
        val moved = moveWidgetDown(DEFAULT_DASHBOARD, 0)
        assertEquals(DashKey.TODAYS_PACK, moved[0].key)
        assertEquals(DEFAULT_DASHBOARD, moveWidgetUp(moved, 1))
        assertEquals(DEFAULT_DASHBOARD, moveWidgetUp(DEFAULT_DASHBOARD, 0))
        assertEquals(DEFAULT_DASHBOARD, moveWidgetDown(DEFAULT_DASHBOARD, DEFAULT_DASHBOARD.lastIndex))
    }

    @Test
    fun setSize_changes_target_keeps_stats_wide() {
        assertEquals(DashSize.WIDE, setWidgetSize(DEFAULT_DASHBOARD, DashKey.TODAYS_PACK, DashSize.WIDE).first { it.key == DashKey.TODAYS_PACK }.size)
        assertEquals(DashSize.WIDE, setWidgetSize(DEFAULT_DASHBOARD, DashKey.STATS, DashSize.COMPACT).first { it.key == DashKey.STATS }.size)
    }

    @Test
    fun hide_then_show_round_trips_appended() {
        val hidden = hideWidget(DEFAULT_DASHBOARD, DashKey.KINTALES)
        assertFalse(hidden.any { it.key == DashKey.KINTALES })
        val shown = showWidget(hidden, DashKey.KINTALES)
        assertTrue(shown.any { it.key == DashKey.KINTALES })
        assertEquals(DashKey.KINTALES, shown.last().key)
    }
}
