package com.tribetails.auntieos.ui.components

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
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
        // exist, because the subtitle is a separate, non-heading Text.
        rule.onNode(isHeading() and hasText("How this invoice adds up"))
            .assertDoesNotExist()
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
