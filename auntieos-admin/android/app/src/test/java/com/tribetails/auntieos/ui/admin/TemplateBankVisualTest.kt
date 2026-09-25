package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
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
}
