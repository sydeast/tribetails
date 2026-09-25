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
}
