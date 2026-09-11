package com.tribetails.auntieos.ui.components

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #445: `DenPanel`'s title carries `Modifier.semantics { heading() }` so
 * TalkBack can navigate a Den screen panel by panel, mirroring web's `h2`/`h3`
 * from PR #417 (#404). Compose has no DOM and no heading level, only the
 * boolean marker asserted here.
 */
private fun isHeading() = SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DenPanelHeadingTest {

    @get:Rule
    val rule = createComposeRule()

    @Test
    fun `the panel title is marked as a heading`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Billing") {}
            }
        }

        rule.onNodeWithText("Billing").assertIsDisplayed()
        rule.onNode(isHeading() and hasText("Billing")).assertIsDisplayed()
    }

    @Test
    fun `the subtitle is not part of the heading`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Billing", subtitle = "How this invoice adds up") {}
            }
        }

        // The heading node's accessible name is the title alone: a node
        // carrying both the heading marker AND the subtitle text does not
        // exist. Since #752 the subtitle is not a Text under the title at all,
        // which settles the question twice over.
        rule.onNode(isHeading() and hasText("How this invoice adds up"))
            .assertDoesNotExist()
    }

    /**
     * #752: "why are there so many unneeded subheadings. at most they can be
     * tool tips, otherwise they are making the ui too busy with unneccessary
     * text" (operator, 2026-09-11).
     */
    @Test
    fun `the subtitle leaves the screen and becomes the info button`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Billing", subtitle = "How this invoice adds up") {}
            }
        }

        // Not a line of copy any more.
        rule.onNodeWithText("How this invoice adds up").assertDoesNotExist()
        // Still reachable: Compose has no `aria-describedby`, so the sentence
        // is the info icon's own description rather than a separate one.
        rule.onNodeWithContentDescription("How this invoice adds up").assertIsDisplayed()
    }

    @Test
    fun `a detail value stays on the screen, with no info button`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Kinfolk", detail = "42 on file") {}
            }
        }

        rule.onNodeWithText("42 on file").assertIsDisplayed()
        rule.onNodeWithContentDescription("42 on file").assertDoesNotExist()
    }

    @Test
    fun `a panel shows its detail and hides its explanation at the same time`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Vet", detail = "3 of 8 on file", subtitle = "Admin only. Internal.") {}
            }
        }

        rule.onNodeWithText("3 of 8 on file").assertIsDisplayed()
        rule.onNodeWithText("Admin only. Internal.").assertDoesNotExist()
        rule.onNodeWithContentDescription("Admin only. Internal.").assertIsDisplayed()
    }

    @Test
    fun `a page heading puts its subtitle behind the info button too`() {
        rule.setContent {
            AuntieOSTheme {
                DenScreenHeading(
                    kicker = "The Den · Schedule",
                    title = "Schedule",
                    subtitle = "Every Kin Care visit on the books.",
                    detail = "Sep 1 to Sep 7",
                )
            }
        }

        rule.onNodeWithText("Sep 1 to Sep 7").assertIsDisplayed()
        rule.onNodeWithText("Every Kin Care visit on the books.").assertDoesNotExist()
        rule.onNodeWithContentDescription("Every Kin Care visit on the books.").assertIsDisplayed()
    }

    @Test
    fun `a collapsible panel still exposes its title as a heading`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Hidden cards", collapsible = true, initiallyExpanded = false) {}
            }
        }

        rule.onNode(isHeading() and hasText("Hidden cards")).assertIsDisplayed()
    }
}
