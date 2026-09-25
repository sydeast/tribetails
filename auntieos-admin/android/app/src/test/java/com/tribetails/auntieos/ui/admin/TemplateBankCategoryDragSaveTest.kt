package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.data.repository.saveTemplatePayload
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #953 review fix round 1, Important #2 (ruling): a drag-to-category save was
 * optimistic with no in-flight cue, and Ruling C1 newly makes that path
 * reachable for visual templates too. This pins that the row shows a visible
 * wait indicator for the exact duration of the save, refuses a second drop on
 * itself while the first is still in flight, and clears once the save
 * resolves.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w400dp-h3000dp")
class TemplateBankCategoryDragSaveTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private val plain = TemplateRepository.EmailTemplate(
        templateId = "k", subject = "S", body = "b", html = null, title = "Booking confirmed",
        description = null, tags = emptyList(), category = "Old",
    )

    /** Long-press-then-drag [cardTitle] onto the chip labeled [chipLabel]. */
    private fun drag(cardTitle: String, chipLabel: String) {
        val cardNode = composeRule.onNodeWithText(cardTitle)
        val cardCenter = cardNode.fetchSemanticsNode().boundsInRoot.center
        val chipCenter = composeRule.onNodeWithText(chipLabel).fetchSemanticsNode().boundsInRoot.center
        val delta = chipCenter - cardCenter
        cardNode.performTouchInput {
            down(center)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            // Two moves: the first crosses touch slop and starts the drag: only a
            // move AFTER that carries the position detectDragGesturesAfterLongPress
            // reports to onDrag.
            moveTo(center + Offset(0f, 60f))
            moveTo(center + delta)
            up()
        }
    }

    @Test
    fun `a drag save shows a wait indicator while blocked, refuses a second drop on the same row, and clears once it resolves`() {
        val r = mockk<TemplateRepository>()
        coEvery { r.listTemplates() } returns Result.success(listOf(plain))
        coEvery { r.listCategories() } returns Result.success(listOf("Old", "New"))
        coEvery { r.listBindings() } returns Result.success(emptyList())
        val gate = CompletableDeferred<Result<String>>()
        coEvery { r.saveTemplate(any(), any()) } coAnswers { gate.await() }

        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()

        drag(cardTitle = "Booking confirmed", chipLabel = "New (0)")
        composeRule.waitForIdle()

        // The save is blocked: the row shows a visible wait indicator.
        composeRule.onNodeWithTag(categorySavingTag("k"), useUnmergedTree = true).assertExists()

        // A second drop on the same row while the first is still saving does
        // nothing new: the card no longer offers the drag gesture at all.
        drag(cardTitle = "Booking confirmed", chipLabel = "Old (0)")
        composeRule.waitForIdle()
        coVerify(exactly = 1) { r.saveTemplate(any(), any()) }
        // Still blocked, still on the original target's category chip.
        composeRule.onNodeWithTag(categorySavingTag("k"), useUnmergedTree = true).assertExists()

        gate.complete(Result.success("k"))
        composeRule.waitForIdle()

        // Once the save resolves, the indicator clears.
        composeRule.onNodeWithTag(categorySavingTag("k"), useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun `a failed drag save reverts the optimistic move and shows the server message verbatim`() {
        val r = mockk<TemplateRepository>()
        coEvery { r.listTemplates() } returns Result.success(listOf(plain))
        coEvery { r.listCategories() } returns Result.success(listOf("Old", "New"))
        coEvery { r.listBindings() } returns Result.success(emptyList())
        coEvery { r.saveTemplate(any(), any()) } returns Result.failure(Exception("category is not allowed"))

        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()

        drag(cardTitle = "Booking confirmed", chipLabel = "New (0)")
        composeRule.waitForIdle()

        // The server's exact message, not a paraphrase.
        composeRule.onNodeWithText("category is not allowed", substring = true).assertExists()
        // The indicator is gone: the failed attempt is over, not stuck "in flight."
        composeRule.onNodeWithTag(categorySavingTag("k"), useUnmergedTree = true).assertDoesNotExist()
        // The optimistic move was reverted: the template is still under "Old".
        composeRule.onNodeWithText("Old (1)").assertExists()
        composeRule.onNodeWithText("New (0)").assertExists()
    }

    // Final review M7: Ruling C1 end to end on a visual card. The bank runs on
    // the real TemplateRepository over a mocked FirebaseFunctions, so the
    // assertion is on the map the saveTemplate callable actually receives.
    private val visualContent =
        "<p>Hi <strong>{{displayName}}</strong>, tap below.&nbsp;</p><p><a href=\"{{link}}\" class=\"button\">Reset Password</a></p>"
    private fun functionsServing(templates: List<Map<String, Any?>>, savePayload: io.mockk.CapturingSlot<Map<String, Any>>): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        fun serve(name: String, data: Any?, capture: io.mockk.CapturingSlot<Map<String, Any>>? = null) {
            val ref = mockk<HttpsCallableReference>()
            val result = mockk<HttpsCallableResult>(relaxed = true)
            every { result.getData() } returns data
            if (capture != null) every { ref.call(capture(capture)) } returns Tasks.forResult(result)
            else every { ref.call(any()) } returns Tasks.forResult(result)
            every { functions.getHttpsCallable(name) } returns ref
        }
        serve("listTemplates", mapOf("templates" to templates))
        serve("listCategories", mapOf("categories" to listOf("Old", "New")))
        serve("listTemplateBindings", mapOf("bindings" to emptyList<Any>()))
        serve("saveTemplate", mapOf("templateId" to "auth.password.reset"), savePayload)
        return functions
    }

    @Test
    fun `dragging a visual card to a category saves the visual shape with only the category changed`() {
        val payload = slot<Map<String, Any>>()
        val functions = functionsServing(
            listOf(mapOf(
                "templateId" to "auth.password.reset", "subject" to "Reset your password", "body" to null, "html" to null,
                "title" to "Password reset", "description" to "", "tags" to listOf("auth"), "category" to "Old",
                "format" to "visual", "headline" to "Choose a new password", "content" to visualContent,
            )),
            payload,
        )
        val r = TemplateRepository(functions)
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        drag(cardTitle = "Password reset", chipLabel = "New (0)")
        composeRule.waitForIdle()
        verify(exactly = 1) { functions.getHttpsCallable("saveTemplate") }
        val loaded = TemplateRepository.EmailTemplate(
            templateId = "auth.password.reset", subject = "Reset your password", body = "", html = null,
            title = "Password reset", description = "", tags = listOf("auth"), category = "Old",
            format = "visual", headline = "Choose a new password", content = visualContent,
        )
        assertEquals(saveTemplatePayload(loaded.copy(category = "New"), expectNew = false), payload.captured)
        assertEquals(
            mapOf(
                "templateId" to "auth.password.reset", "subject" to "Reset your password", "format" to "visual",
                "headline" to "Choose a new password", "content" to visualContent, "title" to "Password reset",
                "description" to "", "tags" to listOf("auth"), "category" to "New",
            ),
            payload.captured,
        )
        assertFalse(payload.captured.containsKey("body"))
        assertFalse(payload.captured.containsKey("html"))
        composeRule.onNodeWithText("New (1)").assertExists()
    }

    @Test
    fun `dragging a card in a format this phone does not know is refused and saves nothing`() {
        val mjml = plain.copy(templateId = "promo", title = "Spring promo", format = "mjml", headline = "H", content = "<mj-body/>")
        val r = mockk<TemplateRepository>()
        coEvery { r.listTemplates() } returns Result.success(listOf(mjml))
        coEvery { r.listCategories() } returns Result.success(listOf("Old", "New"))
        coEvery { r.listBindings() } returns Result.success(emptyList())
        composeRule.setContent { AuntieOSTheme { TemplateBankBody(templateRepo = r) } }
        composeRule.waitForIdle()
        drag(cardTitle = "Spring promo", chipLabel = "New (0)")
        composeRule.waitForIdle()
        coVerify(exactly = 0) { r.saveTemplate(any(), any()) }
        composeRule.onNodeWithText("Move this template on the web admin.").assertExists()
        composeRule.onNodeWithText("Old (1)").assertExists()
    }
}
