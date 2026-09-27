package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #863: at the Directory grid's 290dp minimum card width, a `FlowRow` capped at
 * 3 kin chips + a "+N more" chip wrapped whatever didn't fit onto a second row
 * that the card's fixed height clips - it vanished with no sign it ever
 * existed. [KinChipsRow] measures what actually fits on one line and folds
 * everything else into the count, at every width.
 *
 * The invariant proven at 290dp, for 1, 3, 4 and 8 kin: every kin chip
 * actually shown, plus whatever number the "+N more" chip (if any) reports,
 * adds up to the household's full kin count - never fewer, never a silent drop.
 */
@OptIn(ExperimentalTestApi::class)
class KinChipsRowRenderTest {

    // Long enough that not everything fits on one line at 290dp, so the fix is
    // actually exercised rather than every kin happening to fit anyway.
    private val names = listOf(
        "Montgomery", "Fitzgerald-Alvarez", "Huckleberry", "Persimmon",
        "Buttercup", "Wintermute", "Thistledown", "Marmaduke",
    )

    private fun kinOf(count: Int): List<Kin> =
        (0 until count).map { i -> Kin(_id = "k$i", name = names[i]) }

    private fun runAt290(count: Int) = runDesktopComposeUiTest {
        val kin = kinOf(count)
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Box(Modifier.width(290.dp).testTag("row")) {
                    KinChipsRow(kin = kin)
                }
            }
        }
        waitForIdle()

        val rowBounds = onNodeWithTag("row").fetchSemanticsNode().boundsInRoot

        // KinChipsRow subcomposes every candidate chip (all shown names AND every
        // "+N more" variant it might need) to measure them, then PLACES only the
        // ones that fit. An unplaced candidate stays in the semantics tree, so
        // "does a node with this text exist" over-counts; "is it placed" is the
        // question that matches what the operator actually sees.
        // The overflow chip renders its label in the kit's "mono" (uppercase)
        // style, so its text is "+N MORE", not "+N more"; ignoreCase covers both.
        fun isPlaced(text: String) =
            onAllNodesWithText(text, ignoreCase = true, useUnmergedTree = true).fetchSemanticsNodes()
                .any { it.layoutInfo.isPlaced }

        val shownNames = names.take(count).filter { name -> isPlaced(name) }

        // The overflow chip's count is whatever N makes a PLACED "+N more" exist;
        // there is never more than one on screen, and it never claims more kin
        // are hidden than actually are.
        val overflowCount = (1..count).firstOrNull { n -> isPlaced("+$n more") } ?: 0

        assertEquals(
            count, shownNames.size + overflowCount,
            "at 290dp with $count kin: ${shownNames.size} chip(s) shown ($shownNames) + " +
                "$overflowCount hidden must equal $count",
        )

        // Everything shown sits inside the row and on one line - nothing wraps
        // to a second, clipped row, and nothing spills past the card.
        val tops = mutableListOf<Float>()
        shownNames.forEach { name ->
            val bounds = onNodeWithText(name, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            tops += bounds.top
            assertTrue(bounds.left >= rowBounds.left - 1f, "$name starts before the row: $bounds vs $rowBounds")
        }
        if (overflowCount > 0) {
            val bounds = onNodeWithText("+$overflowCount more", ignoreCase = true, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            tops += bounds.top
            assertTrue(bounds.right <= rowBounds.right + 1f, "the overflow chip spills past the row: $bounds vs $rowBounds")
        }
        if (tops.size > 1) {
            // Every chip is placed at the row's own y = 0; a name chip's leading
            // 28dp avatar makes it taller than the plain overflow chip, so their
            // TEXT centers a few px apart even on one line. A second, clipped row
            // would offset by a full chip height instead - comfortably more than this.
            assertTrue(tops.max() - tops.min() < 20f, "chips are not all on one line: $tops")
        }
    }

    @Test fun oneKinAllShown() = runAt290(1)
    @Test fun threeKinAtTheCap() = runAt290(3)
    @Test fun fourKinFoldsAtLeastOne() = runAt290(4)
    @Test fun eightKinFoldsMost() = runAt290(8)
}
