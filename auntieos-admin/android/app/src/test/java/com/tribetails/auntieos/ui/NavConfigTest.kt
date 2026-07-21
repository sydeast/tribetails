package com.tribetails.auntieos.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 17.4 Nav editor pure-helper tests (android). Mirror of web. */
class NavConfigTest {

    private val def = listOf("home", "directory", "communicate", "settings")

    @Test
    fun empty_resolves_to_default_no_overrides() {
        assertEquals(def.map { NavEntry(it) }, resolvedNav(emptyList(), def))
    }

    @Test
    fun parse_reads_label_drops_unknown_dedupes() {
        assertEquals(
            listOf(NavEntry("home", "Start"), NavEntry("directory", null)),
            parseNavTokens(listOf("home|Start", "bogus", "directory", "home|X"), def.toSet()),
        )
    }

    @Test
    fun parse_blank_label_is_null() {
        assertEquals(listOf(NavEntry("home", null)), parseNavTokens(listOf("home|  "), def.toSet()))
    }

    @Test
    fun resolved_custom_order_and_hidden() {
        val r = resolvedNav(listOf("settings", "home|Start"), def)
        assertEquals(listOf(NavEntry("settings"), NavEntry("home", "Start")), r)
        assertEquals(listOf("directory", "communicate"), hiddenNavKeys(r, def))
    }

    @Test
    fun toNavTokens_round_trips() {
        val e = listOf(NavEntry("home", "Start"), NavEntry("settings", null))
        assertEquals(listOf("home|Start", "settings"), e.toNavTokens())
        assertEquals(e, parseNavTokens(e.toNavTokens(), def.toSet()))
    }

    @Test
    fun label_prefers_custom_then_fallback() {
        assertEquals("Start", NavEntry("home", "Start").label("Home"))
        assertEquals("Home", NavEntry("home", null).label("Home"))
        assertEquals("Home", NavEntry("home", "  ").label("Home"))
    }

    @Test
    fun move_and_bounds() {
        val base = def.map { NavEntry(it) }
        val moved = moveNavDown(base, 0)
        assertEquals("directory", moved[0].key)
        assertEquals(base, moveNavUp(moved, 1))
        assertEquals(base, moveNavUp(base, 0))
        assertEquals(base, moveNavDown(base, base.lastIndex))
    }

    @Test
    fun rename_sets_and_clears() {
        val base = def.map { NavEntry(it) }
        assertEquals("Start", renameNav(base, "home", "Start").first { it.key == "home" }.customLabel)
        assertEquals(null, renameNav(base, "home", "  ").first { it.key == "home" }.customLabel)
    }

    @Test
    fun hide_then_show_appended() {
        val base = def.map { NavEntry(it) }
        val hidden = hideNav(base, "directory")
        assertFalse(hidden.any { it.key == "directory" })
        val shown = showNav(hidden, "directory")
        assertTrue(shown.any { it.key == "directory" })
        assertEquals("directory", shown.last().key)
    }
}
