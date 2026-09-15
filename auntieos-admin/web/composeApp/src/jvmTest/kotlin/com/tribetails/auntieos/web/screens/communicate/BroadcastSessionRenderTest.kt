package com.tribetails.auntieos.web.screens.communicate

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AUNTIE_TIMEOUT_MESSAGE
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #867 re-review: the timeout protection outlives the Broadcast form. Leaving
 * Broadcast mode used to throw away the draft, its idempotency key and the timeout
 * marker, so the resend the error text asks for minted a new key.
 */
@OptIn(ExperimentalTestApi::class)
class BroadcastSessionRenderTest {

    @BeforeTest
    fun setUp() = BroadcastDraftSession.clear()

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
        BroadcastDraftSession.clear()
    }

    private fun ComposeUiTest.shown(text: String, substring: Boolean = false) =
        onAllNodesWithText(text, substring = substring, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private val message = hasSetTextAction() and hasContentDescription("Message")

    private fun ComposeUiTest.openBroadcast() {
        onNode(hasText("Broadcast") and hasClickAction()).performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Send broadcast") }
        waitForIdle()
    }

    /** Presses Send and returns the idempotency key the broadcastMessage call carried. */
    private fun ComposeUiTest.sendAndReadKey(): String {
        JvmFirestoreFixtures.lastCallableName = null
        onNode(hasText("Send broadcast") and hasClickAction()).performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { JvmFirestoreFixtures.lastCallableName == "broadcastMessage" }
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        return payload["idempotencyKey"]!!.jsonPrimitive.content
    }

    @Test
    fun switchingModesAndBackKeepsTheTimeoutNoticeTheDraftAndTheKey() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableErrors = mapOf("broadcastMessage" to AUNTIE_TIMEOUT_MESSAGE)
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { CommunicateScreen() } }

        openBroadcast()
        onNode(hasText("In-app") and hasClickAction()).performScrollTo().performClick()
        onNode(hasText("Text") and hasClickAction()).performScrollTo().performClick()
        onNode(message).performScrollTo().performTextReplacement("Walks are back on Monday.")
        val first = sendAndReadKey()
        waitUntil(timeoutMillis = 10_000) { shown("Send may still be running") }

        onNode(hasText("Personalize") and hasClickAction()).performClick()
        waitUntil(timeoutMillis = 10_000) { !shown("Send broadcast") }
        openBroadcast()

        assertTrue(shown("Send may still be running"), "the timeout notice did not survive the mode switch")
        assertTrue(shown("Walks are back on Monday."), "the draft did not survive the mode switch")
        assertEquals(first, sendAndReadKey(), "an unchanged resend after the mode switch minted a new key")

        onNode(message).performScrollTo().performTextReplacement("Walks are back on Tuesday.")
        waitUntil(timeoutMillis = 10_000) { shown("This will be a new broadcast") }
    }

    @Test
    fun aFreshScreenWithARunningBroadcastShowsTheNoticeAndReusesItsKey() = runDesktopComposeUiTest {
        val sentAtMs = System.currentTimeMillis() - 60_000
        JvmFirestoreFixtures.broadcastRows = listOf(
            Json.parseToJsonElement(
                """{"_id":"key-running-1","actorUid":"u1","fanoutState":"running","sentAtMs":$sentAtMs,
                   "subject":"Holiday hours","body":"We are closed on Thursday.","channels":["sms"],
                   "segmentId":null,"criteria":{"kind":"all"}}""",
            ).jsonObject,
        )
        JvmFirestoreFixtures.callableErrors = mapOf("broadcastMessage" to AUNTIE_TIMEOUT_MESSAGE)
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { CommunicateScreen() } }

        openBroadcast()
        waitUntil(timeoutMillis = 10_000) { shown("\"Holiday hours\" may still be sending", substring = true) }
        assertTrue(shown("Send may still be running"))
        assertTrue(shown("We are closed on Thursday."), "the running broadcast's message was not put back")

        assertEquals("key-running-1", sendAndReadKey())
    }
}
