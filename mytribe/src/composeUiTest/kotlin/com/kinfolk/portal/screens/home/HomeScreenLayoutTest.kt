@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.PortalHomeSection
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #1987: a Limit caps rows and never reshapes Home. Saving one Limit used to
 * turn the two-column page into one stacked column for every household, and a
 * stored layout equal to the default did the same.
 *
 * The page shape is read off where the cards land: on a wide screen Quick start
 * sits to the right of Up next, level with it; on a phone it sits above.
 */
class HomeScreenLayoutTest {

    private fun row(id: String, enabled: Boolean = true, limit: Int = 0) = PortalHomeSection(id, enabled, limit)
    private val defaultRows = listOf("liveVisit", "upNext", "tales", "quickStart").map { row(it) }
    private val limitOnly = defaultRows.map { if (it.id == "upNext") it.copy(limit = 2) else it }

    private fun upcomingVisit(id: String, title: String) = buildJsonObject {
        put("id", id)
        put("kinfolkId", "demo-1")
        put("status", "confirmed")
        put("serviceType", "Walk")
        put("title", title)
        put("batchId", "batch-$id")
        put("startTimeMs", 1_900_000_000_000L)
        put("kinNames", buildJsonArray { add("Buddy") })
    }

    private fun ComposeUiTest.showHome(sections: List<PortalHomeSection>, width: Dp) {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", kotlinx.serialization.json.JsonNull)
            put("upcoming", buildJsonArray {
                add(upcomingVisit("v-1", "Morning walk"))
                add(upcomingVisit("v-2", "Midday walk"))
                add(upcomingVisit("v-3", "Evening walk"))
            })
            put("recent", buildJsonArray {})
        })
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {})
        })
        setThemedContent {
            Box(Modifier.width(width)) {
                HomeScreen("The Foster", "demo-1", PortalApi(fake), sections = sections)
            }
        }
        waitForIdle()
    }

    /** Two columns: Quick start is to the right of Up next and starts level with it. */
    private fun ComposeUiTest.assertTwoColumns() {
        val quick = onNodeWithText("QUICK START").getBoundsInRoot()
        val upNext = onNodeWithText("UP NEXT").getBoundsInRoot()
        assertTrue(quick.left > upNext.right, "Quick start (left ${quick.left}) should be right of Up next (right ${upNext.right})")
        assertTrue(quick.top == upNext.top, "Quick start (top ${quick.top}) should be level with Up next (top ${upNext.top})")
    }

    @Test
    fun wide_noSavedLayout_isTwoColumns() = runComposeUiTest {
        showHome(emptyList(), 1000.dp)
        assertTwoColumns()
        onNodeWithText("Evening walk").assertExists()
    }

    @Test
    fun wide_limitOnly_capsTheRowsAndKeepsTwoColumns() = runComposeUiTest {
        showHome(limitOnly, 1000.dp)
        assertTwoColumns()
        onNodeWithText("Midday walk").assertExists()
        onNodeWithText("Evening walk").assertDoesNotExist()
        onNodeWithText("RECENT KINTALES").assertExists()
    }

    @Test
    fun wide_storedLayoutEqualToTheDefault_isTheDefaultPage() = runComposeUiTest {
        showHome(defaultRows, 1000.dp)
        assertTwoColumns()
        onNodeWithText("Evening walk").assertExists()
    }

    @Test
    fun wide_aHiddenCardInTheStandardOrder_keepsTwoColumnsAndDropsOnlyThatCard() = runComposeUiTest {
        showHome(defaultRows.map { if (it.id == "tales") it.copy(enabled = false) else it }, 1000.dp)
        assertTwoColumns()
        onNodeWithText("RECENT KINTALES").assertDoesNotExist()
    }

    @Test
    fun wide_aRealCustomOrder_isStillOneColumnInThatOrder() = runComposeUiTest {
        showHome(listOf(row("tales"), row("upNext", limit = 1), row("quickStart"), row("liveVisit")), 1000.dp)
        val tales = onNodeWithText("RECENT KINTALES").getBoundsInRoot()
        val upNext = onNodeWithText("UP NEXT").getBoundsInRoot()
        val quick = onNodeWithText("QUICK START").getBoundsInRoot()
        assertTrue(tales.top < upNext.top, "KinTales (${tales.top}) should be above Up next (${upNext.top})")
        assertTrue(upNext.top < quick.top, "Up next (${upNext.top}) should be above Quick start (${quick.top})")
        assertTrue(quick.left == upNext.left, "one column: Quick start (${quick.left}) and Up next (${upNext.left}) share a left edge")
        // Its own limit still applies.
        onNodeWithText("Morning walk").assertExists()
        onNodeWithText("Midday walk").assertDoesNotExist()
    }

    @Test
    fun phone_limitOnly_keepsQuickStartAboveUpNext() = runComposeUiTest {
        showHome(limitOnly, 390.dp)
        val quickTop = onNodeWithText("QUICK START").getBoundsInRoot().top
        val upNextTop = onNodeWithText("UP NEXT").getBoundsInRoot().top
        assertTrue(quickTop < upNextTop, "Quick start ($quickTop) should sit above Up next ($upNextTop)")
        onNodeWithText("Evening walk").assertDoesNotExist()
    }

    @Test
    fun phone_storedLayoutEqualToTheDefault_keepsQuickStartAboveUpNext() = runComposeUiTest {
        showHome(defaultRows, 390.dp)
        val quickTop = onNodeWithText("QUICK START").getBoundsInRoot().top
        val upNextTop = onNodeWithText("UP NEXT").getBoundsInRoot().top
        assertTrue(quickTop < upNextTop, "Quick start ($quickTop) should sit above Up next ($upNextTop)")
    }
}
