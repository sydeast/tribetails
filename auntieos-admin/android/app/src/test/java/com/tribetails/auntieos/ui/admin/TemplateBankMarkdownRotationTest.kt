package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import kotlinx.coroutines.CompletableDeferred
import io.mockk.mockk
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #953 review fix round 1, Important #3: `editingId` (Task 7) makes the bank
 * reopen a template's editor after rotation, but the plain markdown editor's
 * own fields were still `remember`, not `rememberSaveable` — so reopening it
 * silently showed the stored copy, discarding whatever had been typed. This
 * pins that the typed edit now survives, and that the fields nothing here
 * touched (title/description/tags/category) still round-trip unchanged.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class TemplateBankMarkdownRotationTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val plain = TemplateRepository.EmailTemplate(
        templateId = "invoice.sent", subject = "Your invoice", body = "Hi there",
        html = null, title = "Invoice sent", description = "Sent when an invoice goes out",
        tags = listOf("billing"), category = "Billing",
    )

    private fun repo(): TemplateRepository {
        val r = mockk<TemplateRepository>()
        coEvery { r.listTemplates() } returns Result.success(listOf(plain))
        // Empty on purpose: a non-empty category list draws its own suggestion
        // chips, which would echo "Billing" a second time and make the text
        // match below ambiguous.
        coEvery { r.listCategories() } returns Result.success(emptyList())
        coEvery { r.listBindings() } returns Result.success(emptyList())
        return r
    }

    @Test
    fun `rotating mid-edit keeps the typed body, and title, description, tags, category still round-trip`() {
        val tester = StateRestorationTester(composeRule)
        tester.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = repo()) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        // The live preview mirrors the body verbatim, so "Hi there" matches both
        // the input field and the preview text below it; the field is first in
        // composition order.
        composeRule.onAllNodesWithText("Hi there").onFirst().performTextReplacement("Hi there, edited")

        tester.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()

        // The typed edit survived rotation instead of reverting to the stored body
        // (present at least once: the field and its live preview both show it).
        composeRule.onAllNodesWithText("Hi there, edited").onFirst().assertExists()
        // Fields this device never touched are exactly what was loaded (no rebuild-and-wipe).
        composeRule.onNodeWithText("Invoice sent").assertExists()
        composeRule.onNodeWithText("Sent when an invoice goes out").assertExists()
        composeRule.onNodeWithText("billing").assertExists()
        composeRule.onNodeWithText("Billing").assertExists()
    }

    // Final review I1, same rule on the markdown editor the bank also opens:
    // back never throws an edited draft away unasked.
    @Test
    fun `back on an edited markdown draft asks first, and Keep editing keeps the draft`() {
        val r = repo()
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onAllNodesWithText("Hi there").onFirst().performTextReplacement("Hi there, edited")
        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertExists()
        composeRule.onNodeWithText(KEEP_EDITING_LABEL).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertDoesNotExist()
        composeRule.onAllNodesWithText("Hi there, edited").onFirst().assertExists()
        coVerify(exactly = 0) { r.saveTemplate(any(), any()) }
    }

    @Test
    fun `back on an unedited markdown draft leaves at once`() {
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = repo()) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithText("Edit template").assertExists()
        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertDoesNotExist()
        composeRule.onNodeWithText("Edit template").assertDoesNotExist()
    }

    // Final re-review, Concern 3, markdown save: a late answer from an earlier
    // session never closes or marks the reopened editor.
    private fun saveLeaveReopenAndEdit(r: TemplateRepository) {
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithText("Save").performClick()
        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit template").assertDoesNotExist()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onAllNodesWithText("Hi there").onFirst().performTextReplacement("Hi there, new words")
    }

    @Test
    fun `an earlier markdown session's late success leaves the reopened editor and its new edit alone`() {
        val r = repo()
        val gate = CompletableDeferred<Result<String>>()
        coEvery { r.saveTemplate(any(), any()) } coAnswers { gate.await() }
        saveLeaveReopenAndEdit(r)
        gate.complete(Result.success("invoice.sent"))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit template").assertExists()
        composeRule.onAllNodesWithText("Hi there, new words").onFirst().assertExists()
    }

    @Test
    fun `an earlier markdown session's late failure goes to the bank banner, not the reopened editor`() {
        val r = repo()
        val gate = CompletableDeferred<Result<String>>()
        coEvery { r.saveTemplate(any(), any()) } coAnswers { gate.await() }
        saveLeaveReopenAndEdit(r)
        gate.complete(Result.failure(Exception("subject is required")))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit template").assertExists()
        composeRule.onAllNodesWithText("Hi there, new words").onFirst().assertExists()
        composeRule.onNodeWithText("subject is required", substring = true).assertDoesNotExist()
        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(DISCARD_LABEL).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Couldn't save \"Invoice sent\": subject is required", substring = true).assertExists()
    }
}
