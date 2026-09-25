package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** #953 PR 5: the bank sends visual templates to the visual editor and keeps it open across rotation. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class TemplateBankVisualTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val visual = TemplateRepository.EmailTemplate(
        templateId = "auth.password.reset", subject = "Reset your password", body = "", html = null,
        title = "Password reset", description = null, tags = emptyList(), category = null,
        format = "visual", headline = "Choose a new password",
        content = "<p>Hi <strong>{{displayName}}</strong>, tap below.</p>",
    )

    private fun repo(templates: List<TemplateRepository.EmailTemplate>): TemplateRepository {
        val r = mockk<TemplateRepository>()
        coEvery { r.listTemplates() } returns Result.success(templates)
        coEvery { r.listCategories() } returns Result.success(emptyList())
        coEvery { r.listBindings() } returns Result.success(emptyList())
        coEvery { r.previewEmailTemplate(any(), any(), any(), any()) } returns
            Result.success(TemplateRepository.EmailPreview("s", "<p>x</p>", "x", emptyList()))
        coEvery { r.saveTemplate(any(), any()) } returns Result.success(visual.templateId)
        return r
    }

    @Test
    fun `a visual template opens the visual editor and saves the visual shape`() {
        val r = repo(listOf(visual))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        coVerify(exactly = 1) {
            r.saveTemplate(
                match {
                    it.format == "visual" && it.headline == "Choose a new password" &&
                        it.content == "<p>Hi <strong>{{displayName}}</strong>, tap the button.</p>" &&
                        it.description == null && it.category == null
                },
                false,
            )
        }
    }

    // Review fix round 1, Important #1: the report claimed both save paths were
    // exercised; only the payload was. This proves the bank side of a success:
    // the editor closes and the list the operator sees is whatever reload()
    // fetched, not the pre-save snapshot still sitting in memory.
    @Test
    fun `a successful visual save closes the editor and the bank shows the reloaded template`() {
        val updated = visual.copy(title = "Password reset (updated)")
        val r = mockk<TemplateRepository>()
        coEvery { r.listTemplates() } returnsMany listOf(Result.success(listOf(visual)), Result.success(listOf(updated)))
        coEvery { r.listCategories() } returns Result.success(emptyList())
        coEvery { r.listBindings() } returns Result.success(emptyList())
        coEvery { r.previewEmailTemplate(any(), any(), any(), any()) } returns
            Result.success(TemplateRepository.EmailPreview("s", "<p>x</p>", "x", emptyList()))
        coEvery { r.saveTemplate(any(), any()) } returns Result.success(visual.templateId)

        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()

        // Back at the bank (the visual editor's own field is gone)...
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
        // ...showing what the post-save reload() fetched, not the stale in-memory copy.
        composeRule.onNodeWithText("Password reset (updated)").assertExists()
    }

    // Review fix round 1, Important #1: the failed-save path the report claimed
    // was tested and was not. A refused save must stay on the editor with the
    // server's own message, and must not reload (which would discard the draft).
    @Test
    fun `a failed visual save stays on the editor, shows the server message verbatim, and does not reload`() {
        val r = repo(listOf(visual))
        coEvery { r.saveTemplate(any(), any()) } returns Result.failure(Exception("templateId is required"))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()

        // Still on the editor, edit intact: a failed save is not a silent close.
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap the button.")
        // The server's exact message, not a paraphrase.
        composeRule.onNodeWithText("templateId is required").assertExists()
        // Not reloaded: listTemplates() ran only for the initial load.
        coVerify(exactly = 1) { r.listTemplates() }
    }

    // Review Focus 4
    @Test
    fun `rotating mid-edit reopens the editor with the edit`() {
        val r = repo(listOf(visual))
        val tester = StateRestorationTester(composeRule)
        tester.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        tester.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap the button.")
    }

    @Test
    fun `an old template with a custom design still opens subject-only`() {
        val old = visual.copy(format = null, headline = null, content = null, body = "Body", html = "<div>custom</div>")
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = repo(listOf(old))) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithText("This email has a custom design. Edit its body on the web admin.").assertExists()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
    }

    @Test
    fun `a second tap while saving does not save twice`() {
        val r = repo(listOf(visual))
        coEvery { r.saveTemplate(any(), any()) } coAnswers { awaitCancellation() }
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        coVerify(exactly = 1) { r.saveTemplate(any(), any()) }
    }

    @Test
    fun `the viewer shows a visual template's headline and body`() {
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = repo(listOf(visual))) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Password reset").performClick()
        composeRule.onNodeWithText("Choose a new password").assertExists()
        composeRule.onNodeWithText("Hi {{displayName}}, tap below.").assertExists()
    }

    private val welcome = visual.copy(
        templateId = "account.welcome", title = "Welcome", subject = "Welcome aboard",
        headline = "Welcome to the family", content = "<p>So glad you're here.</p>",
    )

    private fun back() {
        composeRule.activity.onBackPressedDispatcher.onBackPressed()
        composeRule.waitForIdle()
    }

    // Final review I1: back must never throw away an edited draft unasked.
    @Test
    fun `back on an edited draft asks first, and Keep editing keeps the draft`() {
        val r = repo(listOf(visual))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        back()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertExists()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithText(KEEP_EDITING_LABEL).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertDoesNotExist()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, tap the button.")
        coVerify(exactly = 0) { r.saveTemplate(any(), any()) }
    }

    @Test
    fun `the Template bank crumb on an edited draft asks first, and Discard leaves without saving`() {
        val r = repo(listOf(visual))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithText("Choose a new password").performTextReplacement("Pick a new password")
        composeRule.onNodeWithText("Template bank").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertExists()
        composeRule.onNodeWithTag(blockTag(0)).assertExists()
        composeRule.onNodeWithText(DISCARD_LABEL).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertDoesNotExist()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
        coVerify(exactly = 0) { r.saveTemplate(any(), any()) }
        // The draft is gone: opening the template again starts from what was stored.
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithText("Choose a new password").assertExists()
    }

    @Test
    fun `back on an unedited draft leaves at once`() {
        val r = repo(listOf(visual))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).assertExists()
        back()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertDoesNotExist()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
        composeRule.onNodeWithText("Password reset").assertExists()
    }

    @Test
    fun `a draft typed back to what was stored leaves at once`() {
        val r = repo(listOf(visual))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap the button.")
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, tap below.")
        back()
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertDoesNotExist()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
    }

    // Final review M1: a save that fails after the operator left must not
    // show its error on the next template opened.
    @Test
    fun `a save that fails after leaving does not land on the next template opened`() {
        val r = repo(listOf(visual, welcome))
        val gate = CompletableDeferred<Result<String>>()
        coEvery { r.saveTemplate(match { it.templateId == visual.templateId }, any()) } coAnswers { gate.await() }
        coEvery { r.saveTemplate(match { it.templateId == welcome.templateId }, any()) } coAnswers { awaitCancellation() }
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText("Edit")[0].performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        back()
        composeRule.onAllNodesWithText("Edit")[1].performClick()
        composeRule.onNodeWithText("Welcome to the family").assertExists()
        // The other template's save is not this one's: Save here is ready.
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).assertIsEnabled()
        gate.complete(Result.failure(Exception("The headline is empty.")))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Couldn't save").assertDoesNotExist()
        composeRule.onNodeWithText("The headline is empty.").assertDoesNotExist()
        composeRule.onNodeWithText("Welcome to the family").assertExists()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).assertIsEnabled()

        // Not silent either: back on the bank, the lost save is named there.
        back()
        composeRule.onNodeWithText("Couldn't save \"Password reset\": The headline is empty.", substring = true)
            .assertExists()
    }

    @Test
    fun `a save that succeeds after leaving does not close the next template opened`() {
        val r = repo(listOf(visual, welcome))
        val gate = CompletableDeferred<Result<String>>()
        coEvery { r.saveTemplate(match { it.templateId == visual.templateId }, any()) } coAnswers { gate.await() }
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText("Edit")[0].performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        back()
        composeRule.onAllNodesWithText("Edit")[1].performClick()
        gate.complete(Result.success(visual.templateId))
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Welcome to the family").assertExists()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("So glad you're here.")
    }

    @Test
    fun `an error from an earlier save does not show when a template is opened again`() {
        val r = repo(listOf(visual, welcome))
        coEvery { r.saveTemplate(any(), any()) } returns Result.failure(Exception("The headline is empty."))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onAllNodesWithText("Edit")[0].performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Couldn't save").assertExists()
        back()
        composeRule.onAllNodesWithText("Edit")[1].performClick()
        composeRule.onNodeWithText("Couldn't save").assertDoesNotExist()
    }

    // Final review M2: a new Save attempt clears the old refusal.
    @Test
    fun `a second Save clears the old Couldn't save banner while it runs`() {
        val r = repo(listOf(visual))
        var calls = 0
        coEvery { r.saveTemplate(any(), any()) } coAnswers {
            calls++
            if (calls == 1) Result.failure(Exception("The headline is empty.")) else awaitCancellation()
        }
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Couldn't save").assertExists()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Couldn't save").assertDoesNotExist()
        composeRule.onNodeWithText("The headline is empty.").assertDoesNotExist()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).assertIsNotEnabled()
    }

    // Final review M3: the preview asks for the sample values of the catalog
    // key that sends the template, the way web does.
    private val bound = visual.copy(templateId = "custom.reset", title = "Custom reset")
    private val binding = TemplateRepository.TemplateBinding(
        catalogKey = "auth.password.reset", templateId = "custom.reset", audience = null, triggerKey = null, active = true,
    )

    @Test
    fun `the editor preview uses the catalog key the template is bound to`() {
        val r = repo(listOf(bound))
        coEvery { r.listBindings() } returns Result.success(listOf(binding))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.mainClock.advanceTimeBy(PREVIEW_DEBOUNCE_MS + 100)
        composeRule.waitForIdle()
        coVerify(atLeast = 1) { r.previewEmailTemplate(any(), any(), any(), "auth.password.reset") }
        coVerify(exactly = 0) { r.previewEmailTemplate(any(), any(), any(), "custom.reset") }
    }

    @Test
    fun `the viewer preview uses the catalog key the template is bound to`() {
        val r = repo(listOf(bound))
        coEvery { r.listBindings() } returns Result.success(listOf(binding))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Custom reset").performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Choose a new password").assertExists()
        composeRule.onNodeWithText(PREVIEW_LOADING_TEXT).assertExists()
        composeRule.waitUntil(timeoutMillis = 5_000) {
            composeRule.onAllNodesWithText(PREVIEW_LOADING_TEXT).fetchSemanticsNodes().isEmpty()
        }
        coVerify(atLeast = 1) { r.previewEmailTemplate(any(), any(), any(), "auth.password.reset") }
        coVerify(exactly = 0) { r.previewEmailTemplate(any(), any(), any(), "custom.reset") }
    }

    @Test
    fun `with no binding the preview falls back to the template key`() {
        val r = repo(listOf(visual))
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.mainClock.advanceTimeBy(PREVIEW_DEBOUNCE_MS + 100)
        composeRule.waitForIdle()
        coVerify(atLeast = 1) { r.previewEmailTemplate(any(), any(), any(), "auth.password.reset") }
    }

    // Final review M8: the template being edited is gone after a reload.
    @Test
    fun `an edited template deleted elsewhere falls back to the bank and never reopens by surprise`() {
        val r = repo(listOf(visual))
        coEvery { r.listTemplates() } returnsMany listOf(
            Result.success(listOf(visual)),
            Result.success(emptyList()),
            Result.success(listOf(visual)),
        )
        val tester = StateRestorationTester(composeRule)
        tester.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).assertExists()
        // Rotation; meanwhile the template was deleted on web.
        tester.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
        composeRule.onNodeWithText("No templates yet. Create one on the web admin.").assertExists()
        // Rotation again; an import has recreated the template under the same key.
        tester.emulateSavedInstanceStateRestore()
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
        composeRule.onNodeWithText("Password reset").assertExists()
    }

    // Final re-review, Concern 3: a save answered after the operator left and
    // reopened the same template belongs to the earlier session, not this one.
    private fun saveLeaveReopenAndEdit(r: TemplateRepository) {
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).performClick()
        back()
        composeRule.onNodeWithTag(blockTag(0)).assertDoesNotExist()
        composeRule.onNodeWithText("Edit").performClick()
        composeRule.onNodeWithTag(blockTag(0)).performTextReplacement("Hi {{displayName}}, new words.")
    }

    @Test
    fun `reopening a template mid-save starts with Save ready, not spinning`() {
        val r = repo(listOf(visual))
        coEvery { r.saveTemplate(any(), any()) } coAnswers { awaitCancellation() }
        saveLeaveReopenAndEdit(r)
        composeRule.onNodeWithTag(VISUAL_SAVE_TAG).assertIsEnabled()
    }

    @Test
    fun `an earlier session's late success leaves the reopened editor and its new edit alone`() {
        val r = repo(listOf(visual))
        val gate = CompletableDeferred<Result<String>>()
        coEvery { r.saveTemplate(any(), any()) } coAnswers { gate.await() }
        saveLeaveReopenAndEdit(r)
        gate.complete(Result.success(visual.templateId))
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, new words.")
        composeRule.onNodeWithText(DISCARD_CHANGES_TITLE).assertDoesNotExist()
    }

    @Test
    fun `an earlier session's late failure goes to the bank banner, not the reopened editor`() {
        val r = repo(listOf(visual))
        val gate = CompletableDeferred<Result<String>>()
        coEvery { r.saveTemplate(any(), any()) } coAnswers { gate.await() }
        saveLeaveReopenAndEdit(r)
        gate.complete(Result.failure(Exception("The headline is empty.")))
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(blockTag(0)).assertTextEquals("Hi {{displayName}}, new words.")
        composeRule.onNodeWithText("The headline is empty.", substring = true).assertDoesNotExist()
        composeRule.onNodeWithText("Couldn't save").assertDoesNotExist()
        back()
        composeRule.onNodeWithText(DISCARD_LABEL).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Couldn't save \"Password reset\": The headline is empty.", substring = true)
            .assertExists()
    }
}
