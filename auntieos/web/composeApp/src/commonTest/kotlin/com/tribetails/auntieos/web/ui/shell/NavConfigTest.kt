package com.tribetails.auntieos.web.ui.shell

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** 17.4 Nav editor pure-helper tests (web/desktop). Mirror of android. */
class NavConfigTest {

    private val def = listOf("Home", "Directory", "KinTales", "Settings")

    @Test
    fun empty_tokens_resolve_to_default_order_no_overrides() {
        assertEquals(def.map { NavEntry(it) }, resolvedNav(emptyList(), def))
    }

    @Test
    fun parse_reads_key_and_custom_label() {
        val r = parseNavTokens(listOf("Home|Dashboard", "Directory"), def.toSet())
        assertEquals(listOf(NavEntry("Home", "Dashboard"), NavEntry("Directory", null)), r)
    }

    @Test
    fun parse_drops_unknown_keys_and_dedupes_first_wins() {
        val r = parseNavTokens(listOf("Bogus", "Home|A", "Home|B"), def.toSet())
        assertEquals(listOf(NavEntry("Home", "A")), r)
    }

    @Test
    fun parse_blank_custom_label_is_null() {
        assertEquals(listOf(NavEntry("Home", null)), parseNavTokens(listOf("Home|   "), def.toSet()))
    }

    @Test
    fun resolved_uses_custom_order_and_omits_hidden() {
        val r = resolvedNav(listOf("Settings", "Home|Start"), def)
        assertEquals(listOf(NavEntry("Settings"), NavEntry("Home", "Start")), r)
        // Directory + KinTales omitted = hidden (Home + Settings are shown)
        assertEquals(listOf("Directory", "KinTales"), hiddenNavKeys(r, def))
    }

    @Test
    fun toNavTokens_round_trips() {
        val entries = listOf(NavEntry("Home", "Start"), NavEntry("Settings", null))
        assertEquals(entries, parseNavTokens(entries.toNavTokens(), def.toSet()))
        assertEquals(listOf("Home|Start", "Settings"), entries.toNavTokens())
    }

    @Test
    fun label_prefers_custom_then_fallback() {
        assertEquals("Start", NavEntry("Home", "Start").label("Home"))
        assertEquals("Home", NavEntry("Home", null).label("Home"))
        assertEquals("Home", NavEntry("Home", "  ").label("Home"))
    }

    @Test
    fun move_down_then_up_restores_and_bounds_noop() {
        val base = def.map { NavEntry(it) }
        val moved = moveNavDown(base, 0)
        assertEquals("Directory", moved[0].key)
        assertEquals(base, moveNavUp(moved, 1))
        assertEquals(base, moveNavUp(base, 0))
        assertEquals(base, moveNavDown(base, base.lastIndex))
    }

    @Test
    fun rename_sets_and_clears_label() {
        val base = def.map { NavEntry(it) }
        assertEquals("Start", renameNav(base, "Home", "Start").first { it.key == "Home" }.customLabel)
        assertEquals(null, renameNav(base, "Home", "   ").first { it.key == "Home" }.customLabel)
    }

    // ---- 17.4 route fail-loud ----

    @Test
    fun routeWarning_null_for_empty_or_known_slug() {
        assertEquals(null, routeWarning(""))
        assertEquals(null, routeWarning("#/"))
        assertEquals(null, routeWarning("#/settings"))
        assertEquals(null, routeWarning("#/directory/abc123"))
    }

    @Test
    fun routeWarning_message_for_unknown_slug() {
        assertEquals("The page \"bogus\" isn't available. Showing Home instead.", routeWarning("#/bogus"))
    }

    @Test
    fun hide_then_show_round_trips_appended() {
        val base = def.map { NavEntry(it) }
        val hidden = hideNav(base, "Directory")
        assertFalse(hidden.any { it.key == "Directory" })
        val shown = showNav(hidden, "Directory")
        assertTrue(shown.any { it.key == "Directory" })
        assertEquals("Directory", shown.last().key)
    }
}
