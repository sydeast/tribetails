@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.messages

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

class MessageAuntieScreenTest {

    @Test
    fun emptyThread_showsHello() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3"); put("messages", buildJsonArray {})
        })
        setThemedContent { MessageAuntieScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("No messages yet").assertIsDisplayed()
    }

    @Test
    fun thread_rendersBubbles() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3")
            put("messages", buildJsonArray {
                add(buildJsonObject { put("id", "m1"); put("senderRole", "kinfolk"); put("senderUid", "u1"); put("body", "Hi there"); put("createdAtMs", 1L) })
                add(buildJsonObject { put("id", "m2"); put("senderRole", "auntie"); put("senderUid", "a"); put("body", "Hello back"); put("createdAtMs", 2L) })
            })
        })
        setThemedContent { MessageAuntieScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Hi there").assertIsDisplayed()
        onNodeWithText("Hello back").assertIsDisplayed()
    }

    @Test
    fun loadError_surfacesFailLoudWithRetry() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyConversation", IllegalStateException("boom"))
        setThemedContent { MessageAuntieScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Couldn't load your messages").assertIsDisplayed()
        // Retry re-calls load; once the server recovers the thread renders.
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3"); put("messages", buildJsonArray {})
        })
        onNodeWithText("Retry").performClick()
        waitForIdle()
        onNodeWithText("No messages yet").assertIsDisplayed()
    }

    @Test
    fun sendError_showsBannerAndKeepsThreadVisible() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3")
            put("messages", buildJsonArray {
                add(buildJsonObject { put("id", "m1"); put("senderRole", "auntie"); put("senderUid", "a"); put("body", "Hello!"); put("createdAtMs", 1L) })
            })
        })
        fake.stubError("sendKinfolkMessage", IllegalStateException("nope"))
        lateinit var controller: MessageAuntieController
        setThemedContent {
            val api = PortalApi(fake)
            controller = rememberMessageAuntieController("3", api)
            MessageAuntieScreen("The Foster", "3", api, controller = controller)
        }
        waitForIdle()
        onNodeWithText("Hello!").assertIsDisplayed()
        controller.send("my draft") { }
        waitForIdle()
        // The failed send shows the inline banner; the thread never blanks.
        onNodeWithText("Your message didn't send.").assertIsDisplayed()
        onNodeWithText("Try again").assertIsDisplayed()
        onNodeWithText("Hello!").assertIsDisplayed()
        onNodeWithText("Couldn't load your messages").assertDoesNotExist()
    }

    @Test
    fun send_showsSendButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject { put("kinfolkId", "3"); put("messages", buildJsonArray {}) })
        setThemedContent { MessageAuntieScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Send").assertIsDisplayed()
    }

    // -- AI message assist (O-8) --

    @Test
    fun assist_polishVisibleButDisabled_whenDraftEmpty() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject { put("kinfolkId", "3"); put("messages", buildJsonArray {}) })
        setThemedContent { MessageAuntieScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Polish").assertIsDisplayed()
        onNodeWithText("Polish").assertIsNotEnabled()
    }

    @Test
    fun assist_suggestPutsResultInComposer() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3")
            put("messages", buildJsonArray {
                add(buildJsonObject { put("id", "m1"); put("senderRole", "auntie"); put("senderUid", "a"); put("body", "How is Rex?"); put("createdAtMs", 1L) })
            })
        })
        fake.stub("generate", buildJsonObject {
            put("ok", true); put("mode", "suggest_reply")
            put("html", "<p>Rex is doing great, thank you!</p>")
            put("text", "Rex is doing great, thank you!")
        })
        setThemedContent { MessageAuntieScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Suggest").performClick()
        waitForIdle()
        // The suggestion lands in the composer field (never auto-sent).
        onNodeWithText("Rex is doing great, thank you!").assertIsDisplayed()
    }

    @Test
    fun assist_errorShowsDismissibleBanner() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3")
            put("messages", buildJsonArray {
                add(buildJsonObject { put("id", "m1"); put("senderRole", "auntie"); put("senderUid", "a"); put("body", "Hello!"); put("createdAtMs", 1L) })
            })
        })
        fake.stubError("generate", IllegalStateException("ai_unavailable"))
        setThemedContent { MessageAuntieScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Suggest").performClick()
        waitForIdle()
        // Warm copy, not the raw server error; the thread stays visible.
        onNodeWithText("The writing helper isn't available right now. Please try again in a moment.").assertIsDisplayed()
        onNodeWithText("Hello!").assertIsDisplayed()
    }
}
