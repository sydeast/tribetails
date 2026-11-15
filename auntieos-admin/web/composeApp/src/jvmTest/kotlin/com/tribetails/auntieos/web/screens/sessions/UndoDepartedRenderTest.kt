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
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #2250 on the console's Auntie Time board, rendered: "Undo departed" on a
 * just-completed card until the moment the server stamped, sent through
 * `setVisitLifecycle`, and the server's refusal shown as written.
 */
@OptIn(ExperimentalTestApi::class)
class UndoDepartedRenderTest {

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun ComposeUiTest.show(session: KinCareSession) {
        JvmFirestoreFixtures.sessions = listOf(session)
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1"))
        JvmFirestoreFixtures.allKin = emptyList()
        JvmFirestoreFixtures.businessSettings = BusinessSettings()
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntieTimeListScreen(onOpenDetail = {}, onWriteKinTale = {}, onViewKinTale = {})
            }
        }
    }

    private fun ComposeUiTest.waitForText(text: String) =
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun ComposeUiTest.count(text: String) = onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun fromNow(seconds: Long): String =
        java.time.Instant.now().plusSeconds(seconds).truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString()

    private fun visit(status: String, undoUntil: String) = KinCareSession(
        _id = "s1",
        kinfolkId = "kf1",
        kinfolkName = "Whitfield",
        status = status,
        startTime = fromNow(-3 * 3600),
        arrivedAt = fromNow(-3 * 3600),
        departedAt = fromNow(-60),
        completedAt = if (status == "COMPLETED") fromNow(-60) else "",
        undoDepartedUntil = undoUntil,
    )

    @Test
    fun aJustCompletedCardOffersUndoDeparted() = runDesktopComposeUiTest {
        show(visit("COMPLETED", fromNow(240)))
        waitForText("Send the KinTale")
        assertEquals(1, count("Undo departed"))
    }

    @Test
    fun aCardStillDepartedOffersItToo() = runDesktopComposeUiTest {
        show(visit("DEPARTED", fromNow(240)))
        waitForText("Send the KinTale")
        assertEquals(1, count("Undo departed"))
    }

    @Test
    fun afterTheWindowOrWithNoneTheButtonIsNotThere() = runDesktopComposeUiTest {
        show(visit("COMPLETED", fromNow(-5)))
        waitForText("Send the KinTale")
        assertEquals(0, count("Undo departed"))
    }

    @Test
    fun aCompletedCardWithNoStampHasNoButton() = runDesktopComposeUiTest {
        show(visit("COMPLETED", ""))
        waitForText("Send the KinTale")
        assertEquals(0, count("Undo departed"))
    }

    @Test
    fun confirmingSendsUndoDepartedThroughSetVisitLifecycle() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "setVisitLifecycle" to
                """{"ok":true,"sessionId":"s1","action":"UNDO_DEPARTED","from":"COMPLETED","status":"ARRIVED","changed":true,"notified":false,"notifySkipped":"no_event_for_action"}""",
        )
        show(visit("COMPLETED", fromNow(240)))
        waitForText("Undo departed")
        onNodeWithText("Undo departed", useUnmergedTree = true).performClick()
        waitForText("Whitfield’s visit will go back to Arrived, with the arrival time it already has. The household is not told.")
        assertEquals(0, JvmFirestoreFixtures.callablePayloads.size)

        onNodeWithText("Yes, undo departed", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { JvmFirestoreFixtures.callablePayloads.isNotEmpty() }
        val (name, json) = JvmFirestoreFixtures.callablePayloads.single()
        assertEquals("setVisitLifecycle", name)
        val payload = Json.parseToJsonElement(json).jsonObject
        assertEquals("s1", payload["sessionId"]?.jsonPrimitive?.content)
        assertEquals("UNDO_DEPARTED", payload["action"]?.jsonPrimitive?.content)
        assertEquals(setOf("sessionId", "action"), payload.keys)
    }

    @Test
    fun aRefusalIsShownInTheServersWords() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableErrors = mapOf(
            "setVisitLifecycle" to "Undo departed is only there for 5 minutes after Departed. That time has passed.",
        )
        show(visit("COMPLETED", fromNow(240)))
        waitForText("Undo departed")
        onNodeWithText("Undo departed", useUnmergedTree = true).performClick()
        waitForText("Yes, undo departed")
        onNodeWithText("Yes, undo departed", useUnmergedTree = true).performClick()
        waitForText(
            "Couldn’t undo the departure. Undo departed is only there for 5 minutes after Departed. That time has passed.",
        )
    }
}
