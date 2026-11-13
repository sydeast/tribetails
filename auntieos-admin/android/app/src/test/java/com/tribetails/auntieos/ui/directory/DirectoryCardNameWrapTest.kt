package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #1964: a Directory card cut a 17-character, three-word name to its first two
 * words and three dots when a PROSPECT or ARCHIVED badge sat in the corner. The
 * name was held to one line beside the room the badge keeps. It now wraps: at a
 * narrow card it takes more than one line, and no line is ellipsized.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class DirectoryCardNameWrapTest {

    @get:Rule
    val rule = createComposeRule()

    /** 17 characters, three words, as in the walk. */
    private val name = "Mae Lynn Ashworth"

    private fun layoutOf(text: String): TextLayoutResult {
        val node = rule.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().first()
        val results = mutableListOf<TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action?.invoke(results)
        return results.single()
    }

    private fun assertWrapsWhole(text: String) {
        val layout = layoutOf(text)
        assertTrue("the name wraps onto a second line at this width (lines=${layout.lineCount})", layout.lineCount > 1)
        assertFalse("the name is not cut off", layout.hasVisualOverflow)
        for (line in 0 until layout.lineCount) {
            assertFalse("line $line is not ellipsized", layout.isLineEllipsized(line))
        }
    }

    @Test
    fun aProspectHouseholdShowsItsWholeNameBesideTheBadge() {
        rule.setContent {
            AuntieOSTheme {
                Box(Modifier.width(300.dp)) {
                    KinfolkDirectoryCard(
                        kf = Kinfolk(id = "kf1", firstName = "Mae Lynn", lastName = "Ashworth", status = "prospect"),
                        kin = emptyList(),
                        lastVisit = null,
                        kintaleCount = 0,
                        isNew = false,
                        onClick = {},
                    )
                }
            }
        }
        assertWrapsWhole(name)
    }

    @Test
    fun anArchivedKinShowsItsWholeNameBesideTheBadge() {
        rule.setContent {
            AuntieOSTheme {
                Box(Modifier.width(300.dp)) {
                    KinDirectoryCard(
                        kin = Kin(id = "k1", name = name, species = "Dog", status = "archived"),
                        ownerName = "",
                        onClick = {},
                    )
                }
            }
        }
        assertWrapsWhole(name)
    }
}
