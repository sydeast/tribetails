package com.tribetails.auntieos.web.screens.communicate

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
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #867 review: the Communicate screen, not just the pure function, warns that an
 * edit after a timed-out broadcast turns the next Send into a second broadcast.
 * `broadcastMessage` answers with the timeout message from a fixture.
 */
@OptIn(ExperimentalTestApi::class)
class BroadcastTimeoutRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    @Test
    fun editingTheDraftAfterATimeoutShowsTheNewBroadcastWarning() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableErrors = mapOf("broadcastMessage" to AUNTIE_TIMEOUT_MESSAGE)
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { CommunicateScreen() } }

        fun shown(text: String) = onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

        onNode(hasText("Broadcast") and hasClickAction()).performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Send broadcast") }

        // Text only, so no subject is needed.
        onNode(hasText("In-app") and hasClickAction()).performScrollTo().performClick()
        onNode(hasText("Text") and hasClickAction()).performScrollTo().performClick()
        val message = hasSetTextAction() and hasContentDescription("Message")
        onNode(message).performScrollTo().performTextReplacement("Walks are back on Monday.")

        onNode(hasText("Send broadcast") and hasClickAction()).performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Send may still be running") }
        assertTrue(!shown("This will be a new broadcast"), "an unchanged draft must not warn")

        onNode(message).performScrollTo().performTextReplacement("Walks are back on Tuesday.")
        waitUntil(timeoutMillis = 10_000) { shown("This will be a new broadcast") }
    }

    /** #867 review: a validation error after a timeout is titled as what it is. */
    @Test
    fun aLaterValidationErrorIsNotTitledAsARunningSend() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableErrors = mapOf("broadcastMessage" to AUNTIE_TIMEOUT_MESSAGE)
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { CommunicateScreen() } }

        fun shown(text: String) = onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

        onNode(hasText("Broadcast") and hasClickAction()).performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Send broadcast") }
        onNode(hasText("In-app") and hasClickAction()).performScrollTo().performClick()
        onNode(hasText("Text") and hasClickAction()).performScrollTo().performClick()
        val message = hasSetTextAction() and hasContentDescription("Message")
        onNode(message).performScrollTo().performTextReplacement("Walks are back on Monday.")
        onNode(hasText("Send broadcast") and hasClickAction()).performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Send may still be running") }

        onNode(message).performScrollTo().performTextReplacement("")
        onNode(hasText("Send broadcast") and hasClickAction()).performScrollTo().performClick()
        waitUntil(timeoutMillis = 10_000) { shown("Write a message first.") && shown("Broadcast blocked") }
        assertTrue(!shown("Send may still be running"), "the validation error kept the timeout title")
    }
}
