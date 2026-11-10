package com.tribetails.auntieos.web.screens.sessions

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1799: on Auntie Time, a DEPARTED card whose KinTale has been sent shows
 * Complete and View KinTale in place of Complete KinTale. Complete reaches the
 * server through `transitionBookingStatus`; View KinTale opens the sent tale.
 */
@OptIn(ExperimentalTestApi::class)
class DepartedCardRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun ComposeUiTest.show(session: KinCareSession, onViewKinTale: (String) -> Unit = {}, onWriteKinTale: (String) -> Unit = {}) {
        JvmFirestoreFixtures.sessions = listOf(session)
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1"))
        JvmFirestoreFixtures.allKin = emptyList()
        JvmFirestoreFixtures.businessSettings = BusinessSettings()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to
                """{"ok":true,"sessionId":"s1","action":"COMPLETE","from":"DEPARTED","status":"COMPLETED","changed":true}""",
        )
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntieTimeListScreen(onOpenDetail = {}, onWriteKinTale = onWriteKinTale, onViewKinTale = onViewKinTale)
            }
        }
    }

    private fun ComposeUiTest.waitForText(text: String) =
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun ComposeUiTest.count(text: String) = onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun departed(eligible: Boolean) = KinCareSession(
        _id = "s1",
        kinfolkId = "kf1",
        kinfolkName = "Whitfield",
        status = "DEPARTED",
        startTime = "2026-11-10T16:00:00Z",
        arrivedAt = "2026-11-10T16:02:00Z",
        departedAt = "2026-11-10T17:00:00Z",
        autoCompleteEligible = eligible,
    )

    @Test
    fun aSentDepartedCardShowsCompleteAndViewKinTale() = runDesktopComposeUiTest {
        show(departed(eligible = true))
        waitForText("View KinTale")
        assertEquals(1, count("Complete"))
        assertEquals(0, count("Complete KinTale"))
    }

    @Test
    fun anUnsentDepartedCardKeepsCompleteKinTale() = runDesktopComposeUiTest {
        show(departed(eligible = false))
        waitForText("Complete KinTale")
        assertEquals(0, count("View KinTale"))
        assertEquals(0, count("Complete"))
    }

    @Test
    fun completeGoesThroughTransitionBookingStatus() = runDesktopComposeUiTest {
        show(departed(eligible = true))
        waitForText("View KinTale")
        onNodeWithText("Complete", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { JvmFirestoreFixtures.callablePayloads.isNotEmpty() }
        val (name, json) = JvmFirestoreFixtures.callablePayloads.single()
        assertEquals("transitionBookingStatus", name)
        val payload = Json.parseToJsonElement(json).jsonObject
        assertEquals("s1", payload["sessionId"]?.jsonPrimitive?.content)
        assertEquals("COMPLETE", payload["action"]?.jsonPrimitive?.content)
        waitForText("Marked Completed.")
    }

    @Test
    fun viewKinTaleOpensTheSentTaleNotANewDraft() = runDesktopComposeUiTest {
        val viewed = mutableListOf<String>()
        val written = mutableListOf<String>()
        show(departed(eligible = true), onViewKinTale = { viewed += it }, onWriteKinTale = { written += it })
        waitForText("View KinTale")
        onNodeWithText("View KinTale", useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals(listOf("s1"), viewed)
        assertTrue(written.isEmpty())
    }
}
