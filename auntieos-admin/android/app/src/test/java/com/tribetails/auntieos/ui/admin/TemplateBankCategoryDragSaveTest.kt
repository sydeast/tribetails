package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import com.tribetails.auntieos.data.repository.TemplateRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
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
}
