package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.draftFromFields
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #2059 (operator ruling 2026-11-13): the KinTales Drafts and Sent rows show the
 * tale's headline as a lighter last line. No headline draws no line; a long one
 * stays one line, and its full text is the content description TalkBack reads.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class KinTaleRowHeadlineTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val long =
        "Biscuit and Mabel spent the whole afternoon chasing leaves around the back garden before a long nap in the sun"

    private fun report(title: String, status: String = "SENT") = KinCareReport(
        id = "r1",
        sessionId = "s1",
        kinfolkName = "The Whitfields",
        serviceType = "Dog Walk",
        visitDate = "2026-07-16T14:00:00.000Z",
        title = title,
        bodyCopy = "Biscuit had a wonderful time at the park today.",
        status = status,
    )

    private fun headlineCount(): Int =
        rule.onAllNodesWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun shownCount(text: String): Int =
        rule.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test
    fun `a sent row shows its headline`() {
        rule.setContent { AuntieOSTheme { ReportRow(report("A great day at the park")) } }
        rule.onNodeWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true).assertIsDisplayed()
        assertEquals(1, shownCount("A great day at the park"))
        assertEquals(1, shownCount("The Whitfields"))
    }

    @Test
    fun `a draft report row shows its headline trimmed`() {
        rule.setContent { AuntieOSTheme { ReportRow(report("  Rainy day indoors  ", status = "DRAFT")) } }
        assertEquals(1, shownCount("Rainy day indoors"))
    }

    @Test
    fun `a row with no headline draws no line`() {
        rule.setContent {
            AuntieOSTheme {
                Column {
                    ReportRow(report(""))
                    ReportRow(report("   "))
                    GeneratedDraftRow(Draft(id = "d1", kinfolkName = "The Okafors"), onOpenDraft = {})
                }
            }
        }
        assertEquals(3, shownCount("The Whitfields") + shownCount("The Okafors"))
        assertEquals(0, headlineCount())
    }

    @Test
    fun `a generated draft shows its generator headline in either spelling`() {
        val camel = Draft(id = "d1", kinfolkName = "The Okafors", generatedTitle = "Mabel naps in the sun")
        val snake = draftFromFields(
            "d2",
            mapOf("kinfolk_name" to "The Lins", "generated_title" to "Rainy day indoors", "status" to "generated"),
        )
        rule.setContent {
            AuntieOSTheme {
                Column {
                    GeneratedDraftRow(camel, onOpenDraft = {})
                    GeneratedDraftRow(snake, onOpenDraft = {})
                }
            }
        }
        assertEquals(1, shownCount("Mabel naps in the sun"))
        assertEquals(1, shownCount("Rainy day indoors"))
        assertEquals(2, headlineCount())
    }

    @Test
    fun `a long headline stays one line and its full text is the content description`() {
        rule.setContent {
            AuntieOSTheme { Box(Modifier.width(320.dp)) { ReportRow(report(long)) } }
        }
        val node = rule.onNodeWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true).fetchSemanticsNode()
        val layouts = mutableListOf<TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        val layout = layouts.single()
        assertEquals("one line, never a wrap", 1, layout.lineCount)
        assertTrue("a 320dp row cannot hold it, so it is cut with an ellipsis", layout.hasVisualOverflow)
        assertEquals(listOf(long), node.config[SemanticsProperties.ContentDescription])
    }

    @Test
    fun `a tap on the headline still opens the tale`() {
        var opened: String? = null
        rule.setContent {
            AuntieOSTheme { ReportRow(report("A great day at the park"), onOpenReport = { opened = it }) }
        }
        rule.onNodeWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true).performClick()
        rule.waitForIdle()
        assertEquals("s1", opened)
    }

    @Test
    fun `the headline helper treats blank as none`() {
        assertNull(kinTaleRowHeadline(""))
        assertNull(kinTaleRowHeadline("   "))
        assertNull(kinTaleRowHeadline(null))
        assertEquals("Park day", kinTaleRowHeadline("  Park day "))
    }

    @Test
    fun `search finds a report and a draft by their headline`() {
        val sent = report("Vet visit went well")
        assertTrue(matchesSearch(sent, "visit went"))
        assertTrue(matchesSearch(sent, "VET VISIT"))
        assertFalse(matchesSearch(sent, "park day"))
        val draft = Draft(id = "d2", kinfolkName = "The Lins", generatedTitle = "Rainy day indoors")
        assertTrue(matchesDraftSearch(draft, "rainy day"))
        assertFalse(matchesDraftSearch(draft, "sunny"))
    }
}
