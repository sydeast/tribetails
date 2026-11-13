package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2059 (operator ruling 2026-11-13): the KinTales Drafts and Sent rows show the
 * tale's headline as a lighter last line. No headline draws no line; a long one
 * stays one line and its full text is the hover tooltip.
 */
@OptIn(ExperimentalTestApi::class)
class KinTaleRowHeadlineRenderTest {

    private val long =
        "Biscuit and Mabel spent the whole afternoon chasing leaves around the back garden before a long nap in the sun"

    private fun report(title: String, status: String = "SENT") = KinCareReport(
        _id = "r1",
        sessionId = "s1",
        kinfolkName = "The Whitfields",
        serviceType = "Dog Walk",
        visitDate = "2026-07-16T14:00:00.000Z",
        title = title,
        bodyCopy = "Biscuit had a wonderful time at the park today.",
        status = status,
    )

    private fun SemanticsNodeInteractionsProvider.headlineCount(): Int =
        onAllNodesWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun SemanticsNodeInteractionsProvider.shownCount(text: String): Int =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size

    @Test
    fun aSentRowShowsItsHeadline() = runDesktopComposeUiTest {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { ReportRow(report("A great day at the park")) } }
        onNodeWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true).assertIsDisplayed()
        assertEquals(1, shownCount("A great day at the park"))
        assertEquals(1, shownCount("The Whitfields"))
    }

    @Test
    fun aDraftReportRowShowsItsHeadlineTooTrimmed() = runDesktopComposeUiTest {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { ReportRow(report("  Rainy day indoors  ", status = "DRAFT")) } }
        assertEquals(1, shownCount("Rainy day indoors"))
    }

    @Test
    fun aRowWithNoHeadlineDrawsNoLine() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                androidx.compose.foundation.layout.Column {
                    ReportRow(report(""))
                    ReportRow(report("   "))
                    GeneratedDraftRow(GeneratedDraft(_id = "d1", kinfolkName = "The Okafors"), onOpenDraft = {})
                }
            }
        }
        assertEquals(3, shownCount("The Whitfields") + shownCount("The Okafors"))
        assertEquals(0, headlineCount())
    }

    @Test
    fun aGeneratedDraftShowsItsGeneratorHeadlineInEitherSpelling() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                androidx.compose.foundation.layout.Column {
                    GeneratedDraftRow(GeneratedDraft(_id = "d1", kinfolkName = "The Okafors", generatedTitle = "Mabel naps in the sun"), onOpenDraft = {})
                    GeneratedDraftRow(GeneratedDraft(_id = "d2", kinfolk_name = "The Lins", generated_title = "Rainy day indoors"), onOpenDraft = {})
                }
            }
        }
        assertEquals(1, shownCount("Mabel naps in the sun"))
        assertEquals(1, shownCount("Rainy day indoors"))
        assertEquals(2, headlineCount())
    }

    @Test
    fun aLongHeadlineStaysOneLineAndHoverShowsTheFullText() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Box(Modifier.width(320.dp)) { ReportRow(report(long)) }
            }
        }
        val node = onNodeWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true)
        val layouts = mutableListOf<TextLayoutResult>()
        node.fetchSemanticsNode().config[SemanticsActions.GetTextLayoutResult].action?.invoke(layouts)
        val layout = layouts.single()
        assertEquals(1, layout.lineCount, "one line, never a wrap")
        assertTrue(layout.hasVisualOverflow, "a 320dp row cannot hold it, so it is cut with an ellipsis")

        node.performMouseInput { moveTo(center) }
        waitUntil(timeoutMillis = 10_000) { shownCount(long) >= 2 }
        assertTrue(shownCount(long) >= 2, "the tooltip carries the full headline beside the clipped line")
    }

    @Test
    fun aTapOnTheHeadlineStillOpensTheTale() = runDesktopComposeUiTest {
        var opened: String? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ReportRow(report("A great day at the park"), onOpenReport = { opened = it })
            }
        }
        onNodeWithTag(KIN_TALE_ROW_HEADLINE_TAG, useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals("s1", opened)
    }

    @Test
    fun theHeadlineHelperTreatsBlankAsNone() {
        assertNull(kinTaleRowHeadline(""))
        assertNull(kinTaleRowHeadline("   "))
        assertNull(kinTaleRowHeadline(null))
        assertEquals("Park day", kinTaleRowHeadline("  Park day "))
    }

    @Test
    fun searchFindsAReportAndADraftByTheirHeadline() {
        val sent = report("Vet visit went well")
        assertTrue(matchesSearch(sent, "visit went"))
        assertTrue(matchesSearch(sent, "VET VISIT"))
        assertFalse(matchesSearch(sent, "park day"))
        val draft = GeneratedDraft(_id = "d2", kinfolk_name = "The Lins", generated_title = "Rainy day indoors")
        assertTrue(matchesDraftSearch(draft, "rainy day"))
        assertFalse(matchesDraftSearch(draft, "sunny"))
    }
}
