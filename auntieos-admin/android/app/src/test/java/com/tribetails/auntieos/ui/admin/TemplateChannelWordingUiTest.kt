package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.repository.PushChannel
import com.tribetails.auntieos.data.repository.PushWording
import com.tribetails.auntieos.data.repository.SmsChannel
import com.tribetails.auntieos.data.repository.TemplateChannels
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #1935: the text-message and push wording editor, driven like an operator would. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class TemplateChannelWordingUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun channels(
        label: String? = "KinCare booking confirmed",
        smsSupported: Boolean = true,
        smsText: String = "Booked for {{kinName}}.",
        pushSupported: Boolean = true,
        pushTitle: String = "Booked",
        pushBody: String = "Tap for the dates.",
    ) = TemplateChannels(
        notificationLabel = label,
        fields = if (label == null) emptyList() else listOf("kinName", "serviceType"),
        sms = SmsChannel(smsSupported, smsText.isNotBlank(), smsText, 1600),
        push = PushChannel(pushSupported, pushTitle.isNotBlank() && pushBody.isNotBlank(), pushTitle, pushBody, 100, 500),
    )

    private class Saves {
        val calls = mutableListOf<Triple<String, String?, PushWording?>>()
        var answer: suspend () -> Result<TemplateChannels> = { Result.failure(IllegalStateException("unset")) }
    }

    private fun show(
        templateId: String? = "kincare.booking.confirm",
        load: suspend (String) -> Result<TemplateChannels> = { Result.success(channels()) },
        saves: Saves = Saves(),
        readOnly: Boolean = false,
    ): Saves {
        composeRule.setContent {
            AuntieOSTheme {
                TemplateChannelWording(
                    templateId = templateId,
                    load = load,
                    save = { id, sms, push -> saves.calls += Triple(id, sms, push); saves.answer() },
                    readOnly = readOnly,
                )
            }
        }
        composeRule.waitForIdle()
        return saves
    }

    private fun inText(text: String) = hasText(text) and hasAnyAncestor(hasTestTag(TEXT_SECTION_TAG))
    private fun inPush(text: String) = hasText(text) and hasAnyAncestor(hasTestTag(PUSH_SECTION_TAG))

    @Test
    fun `shows a loading cue until the wording arrives, then both channels`() {
        val gate = CompletableDeferred<Result<TemplateChannels>>()
        show(load = { gate.await() })
        composeRule.onNodeWithTag(CHANNEL_LOADING_TAG).assertExists()
        composeRule.onNode(inText("Loading…")).assertExists()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertDoesNotExist()

        gate.complete(Result.success(channels()))
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(CHANNEL_LOADING_TAG).assertDoesNotExist()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertTextContains("Booked for {{kinName}}.")
        composeRule.onNodeWithTag(PUSH_TITLE_FIELD_TAG).assertTextContains("Booked")
        composeRule.onNodeWithTag(PUSH_BODY_FIELD_TAG).assertTextContains("Tap for the dates.")
        composeRule.onNode(inText("23 of 1600 characters")).assertExists()
        composeRule.onNode(inPush("6 of 100 characters")).assertExists()
        composeRule.onNode(inPush("18 of 500 characters")).assertExists()
        composeRule.onNode(inText("{{kinName}}")).assertExists()
    }

    // #953 keeps the email editor's draft through a rotation; the text and push
    // drafts drawn under it have to survive the same Activity rebuild.
    @Test
    fun `rotating mid-edit keeps the typed text message and push wording`() {
        val tester = StateRestorationTester(composeRule)
        tester.setContent {
            AuntieOSTheme {
                TemplateChannelWording(
                    templateId = "kincare.booking.confirm",
                    load = { Result.success(channels()) },
                    save = { _, _, _ -> Result.success(channels()) },
                )
            }
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).performTextReplacement("Typed before turning, {{kinName}}.")
        composeRule.onNodeWithTag(PUSH_BODY_FIELD_TAG).performTextReplacement("Half a message")

        tester.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()

        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertTextContains("Typed before turning, {{kinName}}.")
        composeRule.onNodeWithTag(PUSH_BODY_FIELD_TAG).assertTextContains("Half a message")
        composeRule.onNodeWithTag(PUSH_TITLE_FIELD_TAG).assertTextContains("Booked")
    }

    @Test
    fun `rotating after Add text message keeps the new box open`() {
        val tester = StateRestorationTester(composeRule)
        tester.setContent {
            AuntieOSTheme {
                TemplateChannelWording(
                    templateId = "kincare.booking.confirm",
                    load = { Result.success(channels(smsText = "")) },
                    save = { _, _, _ -> Result.success(channels()) },
                )
            }
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Add text message").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).performTextReplacement("A first text")

        tester.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()

        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertTextContains("A first text")
    }

    @Test
    fun `says how many texts the message sends as, and follows the typing`() {
        show()
        composeRule.onNodeWithTag(TEXT_SEGMENTS_TAG).assertTextContains("Sends as 1 text.")
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).performTextReplacement("a".repeat(200))
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(TEXT_SEGMENTS_TAG).assertTextContains("Sends as 2 texts.")
    }

    @Test
    fun `half-written push wording opens to be finished`() {
        show(load = { Result.success(channels(pushTitle = "Booked", pushBody = "")) })
        composeRule.onNodeWithTag(PUSH_TITLE_FIELD_TAG).assertTextContains("Booked")
        composeRule.onNodeWithTag(PUSH_BODY_FIELD_TAG).assertExists()
    }

    @Test
    fun `a failed load says so and Try again asks the server once more`() {
        var calls = 0
        show(load = {
            calls++
            if (calls == 1) Result.failure(IllegalStateException("The server could not be reached. Try again in a moment."))
            else Result.success(channels())
        })
        composeRule.onNodeWithText("The server could not be reached. Try again in a moment.").assertExists()
        composeRule.onNodeWithText("Try again").performClick()
        composeRule.waitForIdle()
        assertEquals(2, calls)
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertExists()
    }

    @Test
    fun `a template not saved yet asks nothing of the server`() {
        var calls = 0
        show(templateId = null, load = { calls++; Result.success(channels()) })
        assertEquals(0, calls)
        composeRule.onNode(inText("Not set")).assertExists()
        composeRule.onNode(inText("Save this template first.")).assertExists()
        composeRule.onNode(inPush("Not set")).assertExists()
        composeRule.onNode(inPush("Save this template first.")).assertExists()
        composeRule.onNodeWithText("Add text message").assertDoesNotExist()
    }

    @Test
    fun `not set with a way to add it, when the notification sends that channel`() {
        show(load = { Result.success(channels(smsText = "", pushTitle = "", pushBody = "")) })
        composeRule.onNode(inText("Not set")).assertExists()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertDoesNotExist()
        composeRule.onNodeWithText("Add text message").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertExists()
        composeRule.onNodeWithTag(TEXT_SAVE_TAG).assertExists()

        composeRule.onNodeWithTag(PUSH_TITLE_FIELD_TAG).assertDoesNotExist()
        composeRule.onNodeWithText("Add push notification").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(PUSH_TITLE_FIELD_TAG).assertExists()
        composeRule.onNodeWithTag(PUSH_BODY_FIELD_TAG).assertExists()
    }

    @Test
    fun `not set with no way to add it, when nothing sends that channel`() {
        show(load = { Result.success(channels(label = null, smsSupported = false, smsText = "", pushSupported = false, pushTitle = "", pushBody = "")) })
        composeRule.onNode(inText("Not set")).assertExists()
        composeRule.onNodeWithText("No notification sends this template, so it has no text message.").assertExists()
        composeRule.onNodeWithText("No notification sends this template, so it has no push notification.").assertExists()
        composeRule.onNodeWithText("Add text message").assertDoesNotExist()
        composeRule.onNodeWithText("Add push notification").assertDoesNotExist()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertDoesNotExist()
    }

    @Test
    fun `a notification that skips a channel says so in its own words`() {
        show(load = { Result.success(channels(smsSupported = false, smsText = "", pushSupported = false, pushTitle = "", pushBody = "")) })
        composeRule.onNodeWithText("This notification is not sent by text message.").assertExists()
        composeRule.onNodeWithText("This notification is not sent as a push notification.").assertExists()
    }

    @Test
    fun `a blank field is stopped here with the server's sentence and nothing is sent`() {
        val saves = show()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).performTextReplacement("   ")
        composeRule.onNodeWithTag(TEXT_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        composeRule.onNode(inText("Text message cannot be empty.")).assertExists()
        assertEquals(0, saves.calls.size)
    }

    @Test
    fun `the server's refusal shows under the field it names`() {
        val refusal = mockk<FirebaseFunctionsException>()
        every { refusal.details } returns mapOf(
            "reason" to "template-wording-refused",
            "fieldErrors" to mapOf("pushBody" to "{{nope}} is not a field this notification fills in. You can use {{kinName}}."),
        )
        every { refusal.message } returns "{{nope}} is not a field this notification fills in. You can use {{kinName}}."
        val saves = Saves().apply { answer = { Result.failure(refusal) } }
        show(saves = saves)
        composeRule.onNodeWithTag(PUSH_BODY_FIELD_TAG).performTextReplacement("Hi {{nope}}")
        composeRule.onNodeWithTag(PUSH_SAVE_TAG).performClick()
        composeRule.waitForIdle()

        composeRule.onNode(inPush("{{nope}} is not a field this notification fills in. You can use {{kinName}}.")).assertExists()
        // Only the push went on the wire, and the text message card is untouched.
        assertEquals(1, saves.calls.size)
        assertNull(saves.calls[0].second)
        assertEquals(PushWording("Booked", "Hi {{nope}}"), saves.calls[0].third)
        composeRule.onNode(inText("{{nope}} is not a field this notification fills in. You can use {{kinName}}.")).assertDoesNotExist()
    }

    @Test
    fun `a failure with no field shows one line beside Save`() {
        val saves = Saves().apply { answer = { Result.failure(IllegalStateException("Your account is not allowed to do this.")) } }
        show(saves = saves)
        composeRule.onNodeWithTag(TEXT_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        composeRule.onNode(inText("Your account is not allowed to do this.")).assertExists()
    }

    @Test
    fun `Save waits visibly, sends only the text message, then says it saved`() {
        val gate = CompletableDeferred<Result<TemplateChannels>>()
        val saves = Saves().apply { answer = { gate.await() } }
        show(saves = saves)
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).performTextReplacement("See you soon, {{kinName}}.")
        composeRule.onNodeWithTag(TEXT_SAVE_TAG).performClick()
        composeRule.waitForIdle()

        composeRule.onNode(inText("Saving…")).assertExists()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertIsNotEnabled()
        // A second tap while it is in flight sends nothing more.
        composeRule.onNodeWithTag(TEXT_SAVE_TAG).performClick()
        assertEquals(1, saves.calls.size)
        assertEquals(Triple("kincare.booking.confirm", "See you soon, {{kinName}}.", null as PushWording?), saves.calls[0])

        gate.complete(Result.success(channels(smsText = "See you soon, {{kinName}}.")))
        composeRule.waitForIdle()
        composeRule.onNode(inText("Text message saved.")).assertExists()
        composeRule.onNode(inText("Saving…")).assertDoesNotExist()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertTextContains("See you soon, {{kinName}}.")
    }

    @Test
    fun `tapping a field adds it to the text message`() {
        show()
        composeRule.onNode(inText("{{serviceType}}")).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertTextContains("Booked for {{kinName}}. {{serviceType}}")
    }

    @Test
    fun `the viewer shows the wording and offers nothing to change`() {
        show(readOnly = true, load = { Result.success(channels(pushTitle = "", pushBody = "")) })
        composeRule.onNode(inText("Booked for {{kinName}}.")).assertExists()
        composeRule.onNodeWithTag(TEXT_FIELD_TAG).assertDoesNotExist()
        composeRule.onNodeWithTag(TEXT_SAVE_TAG).assertDoesNotExist()
        composeRule.onNode(inPush("Not set")).assertExists()
        composeRule.onNodeWithText("Add push notification").assertDoesNotExist()
    }
}
