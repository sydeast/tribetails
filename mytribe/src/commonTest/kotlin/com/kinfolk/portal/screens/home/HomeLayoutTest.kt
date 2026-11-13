package com.kinfolk.portal.screens.home

import com.kinfolk.portal.portal.PortalHomeSection
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1987: the order chooses Home's page shape; a Limit or a hidden card never
 * does. The same vectors the web portal pins in `portalFormat.test.ts`
 * (`homeLayoutMode`), so one operator config draws one page on both clients.
 */
class HomeLayoutTest {

    private fun row(id: String, enabled: Boolean = true, limit: Int = 0) = PortalHomeSection(id, enabled, limit)
    private val defaultRows = listOf("liveVisit", "upNext", "tales", "quickStart").map { row(it) }
    private fun defaultRowsWith(id: String, change: (PortalHomeSection) -> PortalHomeSection) =
        defaultRows.map { if (it.id == id) change(it) else it }

    @Test
    fun noConfig_isTheStandardTwoColumnPage() {
        assertEquals(HomeLayoutMode.Columns, homeLayoutMode(emptyList()))
    }

    @Test
    fun storedLayoutEqualToTheDefault_isTheStandardPage() {
        assertEquals(HomeLayoutMode.Columns, homeLayoutMode(defaultRows))
    }

    @Test
    fun aLimitNeverChangesThePage() {
        assertEquals(HomeLayoutMode.Columns, homeLayoutMode(defaultRowsWith("upNext") { it.copy(limit = 2) }))
        assertEquals(HomeLayoutMode.Columns, homeLayoutMode(defaultRows.map { it.copy(limit = 9) }))
    }

    @Test
    fun aLimitOnACustomOrder_leavesItStacked() {
        val custom = listOf(row("quickStart"), row("liveVisit"), row("upNext"), row("tales"))
        assertEquals(HomeLayoutMode.Stacked, homeLayoutMode(custom))
        assertEquals(
            HomeLayoutMode.Stacked,
            homeLayoutMode(custom.map { if (it.id == "upNext") it.copy(limit = 2) else it }),
        )
    }

    @Test
    fun aMovedSection_isACustomOrder() {
        assertEquals(
            HomeLayoutMode.Stacked,
            homeLayoutMode(listOf(row("upNext"), row("liveVisit"), row("tales"), row("quickStart"))),
        )
        assertEquals(
            HomeLayoutMode.Stacked,
            homeLayoutMode(listOf(row("liveVisit"), row("tales"), row("upNext"), row("quickStart"))),
        )
    }

    @Test
    fun hidingACardInTheStandardOrder_keepsTheColumns() {
        assertEquals(HomeLayoutMode.Columns, homeLayoutMode(defaultRowsWith("tales") { it.copy(enabled = false) }))
        assertEquals(HomeLayoutMode.Columns, homeLayoutMode(defaultRowsWith("liveVisit") { it.copy(enabled = false) }))
    }

    @Test
    fun withNothingToPutSideBySide_thereIsOneColumn() {
        assertEquals(HomeLayoutMode.Stacked, homeLayoutMode(defaultRowsWith("quickStart") { it.copy(enabled = false) }))
        assertEquals(
            HomeLayoutMode.Stacked,
            homeLayoutMode(defaultRows.map { if (it.id == "upNext" || it.id == "tales") it.copy(enabled = false) else it }),
        )
        assertEquals(HomeLayoutMode.Stacked, homeLayoutMode(defaultRows.map { it.copy(enabled = false) }))
    }

    @Test
    fun aLegacyRosterRowOrAnUnknownId_doesNotCountAsAMove() {
        assertEquals(
            HomeLayoutMode.Columns,
            homeLayoutMode(listOf(row("liveVisit"), row("upNext"), row("tales"), row("roster"), row("quickStart"))),
        )
        assertEquals(HomeLayoutMode.Columns, homeLayoutMode(listOf(row("someFutureWidget")) + defaultRows))
    }

    @Test
    fun aRepeatedSection_isNotTheStandardOrder() {
        assertEquals(HomeLayoutMode.Stacked, homeLayoutMode(defaultRows + row("upNext")))
    }

    @Test
    fun resolveHomeLayout_carriesLimitsAndDropsSwitchedOffRows() {
        assertEquals(
            listOf(HomeSectionResolved("liveVisit", 0), HomeSectionResolved("upNext", 2), HomeSectionResolved("quickStart", 0)),
            resolveHomeLayout(
                listOf(row("liveVisit"), row("upNext", limit = 2), row("tales", enabled = false), row("quickStart")),
            ),
        )
    }
}
