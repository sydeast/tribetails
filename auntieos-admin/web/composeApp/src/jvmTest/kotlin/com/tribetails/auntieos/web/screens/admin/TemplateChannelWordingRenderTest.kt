package com.tribetails.auntieos.web.screens.admin

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SkikoComposeUiTest
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.PushNotificationWording
import com.tribetails.auntieos.web.data.PushWording
import com.tribetails.auntieos.web.data.TemplateChannels
import com.tribetails.auntieos.web.data.TemplateService
import com.tribetails.auntieos.web.data.TextMessageWording
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.wordingFieldErrors
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1935: the Text message and Push notification sections of the template
 * editor, drawn. Every call is answered by a lambda or a fixture, so nothing
 * here touches the network.
 */
@OptIn(ExperimentalTestApi::class)
class TemplateChannelWordingRenderTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private fun channels(
        label: String? = "KinCare booking confirmed",
        sms: TextMessageWording = TextMessageWording(supported = true, set = true, text = "Booked for {{kinName}}.", maxLength = 1600),
        push: PushNotificationWording = PushNotificationWording(
            supported = true, set = true, title = "Booked", body = "Tap to see it.", titleMaxLength = 100, bodyMaxLength = 500,
        ),
    ) = TemplateChannels(notificationLabel = label, fields = listOf("kinName", "serviceType"), sms = sms, push = push)

    private val notSetSms = TextMessageWording(supported = true, set = false, text = "", maxLength = 1600)
    private val notSetPush = PushNotificationWording(supported = true, set = false, title = "", body = "", titleMaxLength = 100, bodyMaxLength = 500)
    private val noSms = TextMessageWording(supported = false, set = false, text = "", maxLength = 1600)
    private val noPush = PushNotificationWording(supported = false, set = false, title = "", body = "", titleMaxLength = 100, bodyMaxLength = 500)

    private val neverSaves: suspend (String, String?, PushWording?) -> WriteResult<TemplateChannels> =
        { _, _, _ -> error("this test does not save") }

    private fun SkikoComposeUiTest.show(
        templateId: String? = "kincare.booking.confirm",
        editable: Boolean = true,
        load: suspend (String) -> WriteResult<TemplateChannels>,
        save: suspend (String, String?, PushWording?) -> WriteResult<TemplateChannels> = neverSaves,
    ) {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    TemplateChannelWording(templateId = templateId, load = load, save = save, editable = editable)
                }
            }
        }
    }

    private fun SkikoComposeUiTest.awaitText(text: String) =
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun aLoadInFlightShowsALoadingCueAndNoForm() = runDesktopComposeUiTest {
        val gate = CompletableDeferred<WriteResult<TemplateChannels>>()
        show(load = { gate.await() })
        waitForIdle()
        onNodeWithContentDescription(CHANNEL_LOADING).assertExists()
        onNodeWithText("Loading…").assertExists()
        onNodeWithText("Save text message").assertDoesNotExist()

        gate.complete(WriteResult.Ok(channels()))
        awaitText("Save text message")
        onNodeWithContentDescription(CHANNEL_LOADING).assertDoesNotExist()
    }

    @Test
    fun aFailedLoadShowsTheReasonAndTryAgainLoadsIt() = runDesktopComposeUiTest {
        var calls = 0
        show(load = {
            calls += 1
            if (calls == 1) WriteResult.Err("The server could not be reached. Try again in a moment.")
            else WriteResult.Ok(channels())
        })
        awaitText("Try again")
        onNodeWithText("The server could not be reached. Try again in a moment.").assertExists()
        onNodeWithText("Try again").performClick()
        awaitText("Save push notification")
        assertEquals(2, calls)
    }

    @Test
    fun theTextMessageSaysHowManyTextsItSendsAs() = runDesktopComposeUiTest {
        show(load = { WriteResult.Ok(channels(sms = TextMessageWording(true, true, "a".repeat(200), 1600))) })
        awaitText("Save text message")
        onNodeWithText("Sends as 2 texts.").assertExists()
    }

    @Test
    fun storedWordingIsShownWithItsCountsAndTheFieldsItCanUse() = runDesktopComposeUiTest {
        show(load = { WriteResult.Ok(channels()) })
        awaitText("Save text message")
        onNodeWithText("Text message").assertExists()
        onNodeWithText("Push notification").assertExists()
        onNodeWithText("Booked for {{kinName}}.").assertExists()
        onNodeWithText("23 of 1600 characters").assertExists()
        onNodeWithText("Booked").assertExists()
        onNodeWithText("6 of 100 characters").assertExists()
        onNodeWithText("14 of 500 characters").assertExists()
        // One chip row per channel, each field as the operator types it.
        assertEquals(2, onAllNodesWithText("{{serviceType}}").fetchSemanticsNodes().size)
        onAllNodesWithText("Not set").fetchSemanticsNodes().let { assertTrue(it.isEmpty()) }
    }

    @Test
    fun notSetButSendableOffersAddAndAddOpensAnEmptyForm() = runDesktopComposeUiTest {
        show(load = { WriteResult.Ok(channels(sms = notSetSms, push = notSetPush)) })
        awaitText("Add text message")
        assertEquals(2, onAllNodesWithText("Not set").fetchSemanticsNodes().size)
        onNodeWithText("Add push notification").assertExists()
        onNodeWithText("Save text message").assertDoesNotExist()

        onNodeWithText("Add text message").performClick()
        awaitText("Save text message")
        onNodeWithText("0 of 1600 characters").assertExists()
        // The push notification is still waiting to be added.
        onNodeWithText("Add push notification").assertExists()
    }

    @Test
    fun aChannelTheNotificationDoesNotSendIsNotSetWithNoWayToAddIt() = runDesktopComposeUiTest {
        show(load = { WriteResult.Ok(channels(label = "Password reset", sms = noSms, push = noPush)) })
        awaitText("This notification is not sent by text message.")
        onNodeWithText("This notification is not sent as a push notification.").assertExists()
        assertEquals(2, onAllNodesWithText("Not set").fetchSemanticsNodes().size)
        onNodeWithText("Add text message").assertDoesNotExist()
        onNodeWithText("Add push notification").assertDoesNotExist()
    }

    @Test
    fun aTemplateNoNotificationSendsSaysSoForBothChannels() = runDesktopComposeUiTest {
        show(load = { WriteResult.Ok(channels(label = null, sms = noSms, push = noPush)) })
        awaitText("No notification sends this template, so it has no text message.")
        onNodeWithText("No notification sends this template, so it has no push notification.").assertExists()
        onNodeWithText("Add text message").assertDoesNotExist()
    }

    @Test
    fun aNewTemplateAsksNothingOfTheServer() = runDesktopComposeUiTest {
        var calls = 0
        show(templateId = null, load = { calls += 1; WriteResult.Ok(channels()) })
        waitForIdle()
        assertEquals(2, onAllNodesWithText("Not set").fetchSemanticsNodes().size)
        assertEquals(2, onAllNodesWithText("Save this template first.").fetchSemanticsNodes().size)
        onNodeWithText("Add text message").assertDoesNotExist()
        assertEquals(0, calls)
    }

    @Test
    fun anEmptyTextMessageIsStoppedHereWithTheErrorUnderItsField() = runDesktopComposeUiTest {
        var saves = 0
        show(
            load = { WriteResult.Ok(channels()) },
            save = { _, _, _ -> saves += 1; WriteResult.Ok(channels()) },
        )
        awaitText("Save text message")
        onNodeWithContentDescription("Text message").performTextReplacement("   ")
        onNodeWithText("Save text message").performClick()
        awaitText("Text message cannot be empty.")
        assertEquals(0, saves)
        // Typing clears it: the message answers what was on screen, not what is now.
        onNodeWithContentDescription("Text message").performTextInput("Hi")
        waitForIdle()
        onNodeWithText("Text message cannot be empty.").assertDoesNotExist()
    }

    @Test
    fun aServerRefusalLandsUnderTheFieldItNames() = runDesktopComposeUiTest {
        val refusal = "{{nopeVar}} is not a field this notification fills in. You can use {{kinName}}, {{serviceType}}."
        show(
            load = { WriteResult.Ok(channels()) },
            save = { _, _, _ ->
                WriteResult.Err(
                    message = refusal,
                    details = """{"reason":"template-wording-refused","fieldErrors":{"pushBody":"$refusal"}}""",
                )
            },
        )
        awaitText("Save push notification")
        onNodeWithContentDescription("Message").performTextReplacement("Hi {{nopeVar}}")
        onNodeWithText("Save push notification").performClick()
        awaitText(refusal)
        // Once, under Message: not repeated beside the button, and not under Title.
        assertEquals(1, onAllNodesWithText(refusal).fetchSemanticsNodes().size)
        onNodeWithText("Push notification saved.").assertDoesNotExist()
    }

    @Test
    fun aFailureThatNamesNoFieldShowsOnceBesideTheButton() = runDesktopComposeUiTest {
        show(
            load = { WriteResult.Ok(channels()) },
            save = { _, _, _ -> WriteResult.Err("Your account is not allowed to do this.") },
        )
        awaitText("Save text message")
        onNodeWithText("Save text message").performClick()
        awaitText("Your account is not allowed to do this.")
        onNodeWithText("Text message saved.").assertDoesNotExist()
    }

    @Test
    fun whileSavingTheButtonIsOffAndSaysSoThenTheSavedWordingReplacesTheDraft() = runDesktopComposeUiTest {
        val gate = CompletableDeferred<WriteResult<TemplateChannels>>()
        val sent = mutableListOf<Triple<String, String?, PushWording?>>()
        show(
            load = { WriteResult.Ok(channels()) },
            save = { id, text, push -> sent += Triple(id, text, push); gate.await() },
        )
        awaitText("Save text message")
        onNodeWithContentDescription("Text message").performTextReplacement("  New words.  ")
        onNodeWithText("Save text message").performClick()
        awaitText("Saving…")
        // The busy button swaps its label for a spinner and takes no press.
        onNodeWithText("Save text message").assertDoesNotExist()
        // Only the text message went, exactly as typed; the server trims.
        assertEquals(listOf(Triple("kincare.booking.confirm", "  New words.  ", null as PushWording?)), sent.toList())

        gate.complete(WriteResult.Ok(channels(sms = TextMessageWording(true, true, "New words.", 1600))))
        awaitText("Text message saved.")
        onNodeWithText("Saving…").assertDoesNotExist()
        onNodeWithText("Save text message").assertExists()
        onNodeWithText("New words.").assertExists()
        onNodeWithText("10 of 1600 characters").assertExists()
    }

    @Test
    fun aFieldChipDropsItsNameIntoTheTextMessage() = runDesktopComposeUiTest {
        show(load = { WriteResult.Ok(channels(sms = TextMessageWording(true, true, "", 1600).copy(set = true), push = noPush)) })
        awaitText("Save text message")
        onNodeWithText("{{kinName}}").performClick()
        awaitText("11 of 1600 characters")
    }

    @Test
    fun theReadOnlyViewerShowsTheWordingAndNothingToPress() = runDesktopComposeUiTest {
        show(editable = false, load = { WriteResult.Ok(channels(push = notSetPush)) })
        awaitText("Booked for {{kinName}}.")
        onNodeWithText("Save text message").assertDoesNotExist()
        onNodeWithText("Not set").assertExists()
        onNodeWithText("Add push notification").assertDoesNotExist()
    }

    // ── the service, through the real callable seam ──────────────────────────

    @Test
    fun theServiceReadsThroughGetTemplateChannels() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "getTemplateChannels" to
                """{"templateId":"invoice.new","notificationLabel":"New invoice","fields":["amount"],
                    "sms":{"supported":true,"set":false,"text":"","maxLength":1600},
                    "push":{"supported":true,"set":true,"title":"Invoice","body":"A new one.","titleMaxLength":100,"bodyMaxLength":500}}""",
        )
        val r = TemplateService().getTemplateChannels("invoice.new")
        assertTrue(r is WriteResult.Ok)
        assertEquals("New invoice", (r as WriteResult.Ok).value.notificationLabel)
        assertEquals("getTemplateChannels", JvmFirestoreFixtures.lastCallableName)
        assertEquals(setOf("templateId"), Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject.keys)
    }

    @Test
    fun aRefusedSaveKeepsTheServersFieldErrors() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("saveTemplateChannels" to "Text message cannot be empty.")
        JvmFirestoreFixtures.callableErrorDetails = mapOf(
            "saveTemplateChannels" to
                """{"reason":"template-wording-refused","fieldErrors":{"smsText":"Text message cannot be empty."}}""",
        )
        val r = TemplateService().saveTemplateChannels("invoice.new", " ", null)
        assertTrue(r is WriteResult.Err)
        assertEquals(
            mapOf("smsText" to "Text message cannot be empty."),
            wordingFieldErrors(r as WriteResult.Err),
        )
        assertEquals(
            setOf("templateId", "sms"),
            Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject.keys,
        )
    }

    @Test
    fun anAnswerThatCannotBeReadIsAPlainSentenceNotADecodeError() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("getTemplateChannels" to "not json")
        val r = TemplateService().getTemplateChannels("invoice.new")
        assertTrue(r is WriteResult.Err)
        assertEquals("Something went wrong on our side. Try again in a moment.", (r as WriteResult.Err).message)
    }
}
