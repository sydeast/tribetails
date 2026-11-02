package com.tribetails.auntieos.web.ui.components

import androidx.compose.material3.Text
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * #1430, ruling 2026-09-11: a panel or screen heading never draws its subtitle
 * as a line under the title. The sentence sits behind an info tip, and no text
 * node carries it until the tip is opened. The clock is held so the plain
 * tooltip's auto-dismiss cannot close it before the assertion runs.
 */
@OptIn(ExperimentalTestApi::class)
class DenSubtitleTipRenderTest {

    private val tip = "Counts only visits already marked done."

    @Test
    fun panelSubtitleIsNotTextUntilTheTipIsOpened() = runDesktopComposeUiTest {
        mainClock.autoAdvance = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                DenPanel(title = "Visits", subtitle = tip) { Text("body") }
            }
        }
        mainClock.advanceTimeBy(16L)
        assertTrue(onAllNodesWithText(tip).fetchSemanticsNodes().isEmpty())
        onNodeWithTag(AUNTIE_INFO_TIP_TAG).performClick()
        mainClock.advanceTimeBy(300L)
        onNodeWithText(tip).assertIsDisplayed()
    }

    @Test
    fun panelIconHasAContentDescription() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                DenPanel(title = "Visits", subtitle = tip) { Text("body") }
            }
        }
        onNodeWithContentDescription(tip, useUnmergedTree = true).assertIsDisplayed()
    }

    @Test
    fun screenHeadingSubtitleIsNotTextUntilTheTipIsOpened() = runDesktopComposeUiTest {
        mainClock.autoAdvance = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                DenScreenHeading(kicker = "Ops", title = "Visits", subtitle = tip)
            }
        }
        mainClock.advanceTimeBy(16L)
        assertTrue(onAllNodesWithText(tip).fetchSemanticsNodes().isEmpty())
        onNodeWithContentDescription(tip, useUnmergedTree = true).assertIsDisplayed()
        onNodeWithTag(AUNTIE_INFO_TIP_TAG).performClick()
        mainClock.advanceTimeBy(300L)
        onNodeWithText(tip).assertIsDisplayed()
    }
}
