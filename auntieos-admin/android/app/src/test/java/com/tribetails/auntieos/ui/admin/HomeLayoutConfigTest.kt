package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.PortalHomeSection
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
            listOf("liveVisit", "upNext", "tales", "roster", "quickStart"),
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

    // ── One-way-door guard (issue #397 M10 follow-up) ──────────────────────

    @Test
    fun `homeLayoutModeLabel is Default layout only for an empty list`() {
        assertEquals("Default layout", homeLayoutModeLabel(emptyList()))
    }

    @Test
    fun `homeLayoutModeLabel is Custom layout for any non-empty list, even one matching canonical defaults`() {
        val canonicalLooking = HOME_SECTION_CATALOG.map { PortalHomeSection(it.id, enabled = true, limit = 0) }
        assertEquals("Custom layout", homeLayoutModeLabel(canonicalLooking))
        assertEquals("Custom layout", homeLayoutModeLabel(abc))
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
