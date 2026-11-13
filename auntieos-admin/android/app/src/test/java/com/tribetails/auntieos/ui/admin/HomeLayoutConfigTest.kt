package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.DEFAULT_HOME_SECTION_IDS
import com.tribetails.auntieos.data.model.PortalHomeSection
import com.tribetails.auntieos.data.model.isDefaultHomeLayout
import com.tribetails.auntieos.data.model.normalizeHomeSections
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * ISSUE #397 M10: pure-helper tests for the kinfolk portal Home layout editor.
 * Mirror of the web `settingsFormat.test.ts` cases for `effectiveHomeSections`
 * / `moveHomeSectionUp` / `moveHomeSectionDown` (auntieos-admin
 * src/lib/settingsFormat.ts) -- three independent test files pinning the same
 * two-branch rule because none of the three clients share a source tree.
 */
class HomeLayoutConfigTest {

    @Test
    fun `catalogue ids and labels`() {
        assertEquals(
            listOf("liveVisit", "upNext", "tales", "quickStart"),
            HOME_SECTION_CATALOG.map { it.id },
        )
        assertEquals("Live visit", homeSectionLabel("liveVisit"))
        assertEquals("Recent KinTales", homeSectionLabel("tales"))
    }

    @Test
    fun `homeSectionLabel falls back to the raw id for an unknown section`() {
        assertEquals("futureSection", homeSectionLabel("futureSection"))
    }

    @Test
    fun `homeSectionLabel never leaves a blank id unnamed`() {
        assertEquals("Unnamed section", homeSectionLabel(""))
    }

    @Test
    fun `an empty stored list materializes the canonical order, everything enabled and unlimited`() {
        val expected = HOME_SECTION_CATALOG.map { PortalHomeSection(id = it.id, enabled = true, limit = 0) }
        assertEquals(expected, effectiveHomeSections(emptyList()))
    }

    @Test
    fun `a fully-configured list is returned untouched`() {
        val configured = HOME_SECTION_CATALOG.map { PortalHomeSection(id = it.id, enabled = false, limit = 2) }
        assertEquals(configured, effectiveHomeSections(configured))
    }

    @Test
    fun `a partial list gets every omitted catalogue section appended, disabled`() {
        val partial = listOf(PortalHomeSection("upNext", enabled = true, limit = 5))
        val result = effectiveHomeSections(partial)
        assertEquals(PortalHomeSection("upNext", true, 5), result.first())
        val rest = result.drop(1)
        assertEquals(HOME_SECTION_CATALOG.size - 1, rest.size)
        assertEquals(true, rest.all { !it.enabled && it.limit == 0 })
    }

    @Test
    fun `a legacy or unknown id survives rather than being dropped`() {
        val legacy = listOf(PortalHomeSection("retiredSection", enabled = true, limit = 0))
        val result = effectiveHomeSections(legacy)
        assertEquals(PortalHomeSection("retiredSection", true, 0), result.first())
        assertEquals(1 + HOME_SECTION_CATALOG.size, result.size)
    }

    private val abc = listOf("a", "b", "c").map { PortalHomeSection(it, true, 0) }

    @Test
    fun `move up and down swap one step`() {
        assertEquals(listOf("b", "a", "c"), moveHomeSectionUp(abc, 1).map { it.id })
        assertEquals(listOf("a", "c", "b"), moveHomeSectionDown(abc, 1).map { it.id })
    }

    @Test
    fun `move is a no-op at either edge or out of range`() {
        assertEquals(abc, moveHomeSectionUp(abc, 0))
        assertEquals(abc, moveHomeSectionDown(abc, abc.lastIndex))
        assertEquals(abc, moveHomeSectionUp(abc, -1))
        assertEquals(abc, moveHomeSectionDown(abc, abc.size))
    }

    @Test
    fun `moving up then down round-trips to the original order`() {
        assertEquals(abc, moveHomeSectionDown(moveHomeSectionUp(abc, 2), 1))
    }

    @Test
    fun `replacedAt swaps only the targeted row`() {
        val replaced = abc.replacedAt(1, PortalHomeSection("b", enabled = false, limit = 9))
        assertEquals(listOf(abc[0], PortalHomeSection("b", false, 9), abc[2]), replaced)
    }

    @Test
    fun `replacedAt is a no-op out of range`() {
        assertEquals(abc, abc.replacedAt(-1, abc[0]))
        assertEquals(abc, abc.replacedAt(abc.size, abc[0]))
    }

    // ── #1987: a layout equal to the default IS the default ────────────────
    //
    // This block used to pin the opposite ("Custom layout for any non-empty
    // list, even one matching canonical defaults"), the rule that left the
    // pill on Custom and the portal in one stacked column after a Limit was
    // typed and put back. Same vectors as the server (homeLayoutDefault.test.ts)
    // and the React admin (settingsFormat.test.ts).
    private fun row(id: String, enabled: Boolean = true, limit: Int = 0) = PortalHomeSection(id, enabled, limit)
    private val defaultRows = HOME_SECTION_CATALOG.map { row(it.id) }
    private val limitOnly = defaultRows.map { if (it.id == "upNext") it.copy(limit = 2) else it }
    private val customOrder = listOf(row("quickStart"), row("liveVisit"), row("upNext"), row("tales"))
    @Test
    fun `the catalogue and the model's default ids are the same list`() {
        assertEquals(DEFAULT_HOME_SECTION_IDS, HOME_SECTION_CATALOG.map { it.id })
    }
    @Test
    fun `isDefaultHomeLayout is true for the empty list and for the four default rows written out`() {
        assertEquals(true, isDefaultHomeLayout(emptyList()))
        assertEquals(true, isDefaultHomeLayout(defaultRows))
    }
    @Test
    fun `isDefaultHomeLayout is false as soon as a limit, a switch or the order differs`() {
        assertEquals(false, isDefaultHomeLayout(limitOnly))
        assertEquals(false, isDefaultHomeLayout(defaultRows.map { if (it.id == "tales") it.copy(enabled = false) else it }))
        assertEquals(false, isDefaultHomeLayout(customOrder))
    }
    @Test
    fun `isDefaultHomeLayout never calls a list with a row it does not know the default`() {
        assertEquals(false, isDefaultHomeLayout(defaultRows + row("roster")))
        assertEquals(false, isDefaultHomeLayout(defaultRows.take(3) + row("roster") + row("quickStart")))
        assertEquals(false, isDefaultHomeLayout(defaultRows + row("somethingNew")))
        assertEquals(false, isDefaultHomeLayout(defaultRows + row("tales")))
        assertEquals(false, isDefaultHomeLayout(defaultRows.take(3) + row("")))
        assertEquals(false, isDefaultHomeLayout(defaultRows.take(3)))
    }
    @Test
    fun `normalizeHomeSections holds a layout equal to the default as the empty list and leaves the rest alone`() {
        assertEquals(emptyList<PortalHomeSection>(), normalizeHomeSections(defaultRows))
        assertEquals(limitOnly, normalizeHomeSections(limitOnly))
        assertEquals(customOrder, normalizeHomeSections(customOrder))
        assertEquals(defaultRows + row("roster"), normalizeHomeSections(defaultRows + row("roster")))
    }
    @Test
    fun `homeLayoutModeLabel is Default layout for an empty list and for stored rows equal to the default`() {
        assertEquals("Default layout", homeLayoutModeLabel(emptyList()))
        assertEquals("Default layout", homeLayoutModeLabel(defaultRows))
    }
    @Test
    fun `homeLayoutModeLabel is Custom layout for a limit, a hidden section or a custom order`() {
        assertEquals("Custom layout", homeLayoutModeLabel(limitOnly))
        assertEquals("Custom layout", homeLayoutModeLabel(customOrder))
        assertEquals("Custom layout", homeLayoutModeLabel(abc))
    }
    /** The panel's own steps: materialize, patch one Limit, then put it back. */
    @Test
    fun `a Limit typed and put back returns the draft to the default`() {
        val typed = normalizeHomeSections(effectiveHomeSections(emptyList()).replacedAt(1, row("upNext", limit = 2)))
        assertEquals(limitOnly, typed)
        assertEquals("Custom layout", homeLayoutModeLabel(typed))
        val putBack = normalizeHomeSections(effectiveHomeSections(typed).replacedAt(1, row("upNext", limit = 0)))
        assertEquals(emptyList<PortalHomeSection>(), putBack)
        assertEquals("Default layout", homeLayoutModeLabel(putBack))
    }
    @Test
    fun `a section moved and moved back returns the draft to the default`() {
        val moved = normalizeHomeSections(moveHomeSectionDown(effectiveHomeSections(emptyList()), 0))
        assertEquals("Custom layout", homeLayoutModeLabel(moved))
        assertEquals(emptyList<PortalHomeSection>(), normalizeHomeSections(moveHomeSectionUp(effectiveHomeSections(moved), 1)))
    }
    @Test
    fun `RESET_HOME_SECTIONS is the empty list the portal reads as its own implicit default`() {
        assertEquals(emptyList<PortalHomeSection>(), RESET_HOME_SECTIONS)
        assertEquals("Default layout", homeLayoutModeLabel(RESET_HOME_SECTIONS))
        // Materializing the reset value for DISPLAY still shows the full
        // canonical, everything-enabled list -- resetting never leaves the
        // editor showing a blank screen.
        assertEquals(
            HOME_SECTION_CATALOG.map { PortalHomeSection(it.id, enabled = true, limit = 0) },
            effectiveHomeSections(RESET_HOME_SECTIONS),
        )
    }
}
