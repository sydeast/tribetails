package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #1759: Settings > Integrations on Android drew each service's purpose as a
 * standing line under its name. The 2026-09-11 ruling ("at most they can be
 * tool tips") puts it behind the info tip beside the name, as web's
 * `TitleWithTip` does since #1758. The name stays a node of its own, so
 * TalkBack reads the name alone and the tip's content description carries
 * the purpose.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35])
class IntegrationCardPurposeTipTest {

    @get:Rule
    val rule = createComposeRule()

    private val name = "Zapier"
    private val purpose = "Automate workflows across thousands of apps"

    private fun mount(purposeText: String = purpose) {
        rule.setContent {
            AuntieOSTheme {
                IntegrationCard(
                    name = name,
                    purpose = purposeText,
                    stateLabel = "Coming soon",
                    stateTone = AuntieStatusTone.Muted,
                )
            }
        }
    }

    @Test
    fun purposeIsNotAStandingLine() {
        mount()
        rule.onAllNodesWithText(purpose, substring = true, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test
    fun purposeIsTheTipsContentDescription() {
        mount()
        rule.onNodeWithContentDescription(purpose, useUnmergedTree = true).assertExists()
        rule.onNodeWithContentDescription(purpose).assertHasClickAction()
    }

    @Test
    fun nameNodeIsTheNameAlone() {
        mount()
        rule.onNodeWithText(name).assertTextEquals(name)
        rule.onAllNodesWithContentDescription(name, substring = true).assertCountEquals(0)
    }

    @Test
    fun blankPurposeDrawsNoTip() {
        mount(purposeText = "")
        rule.onNodeWithText(name).assertTextEquals(name)
        // No control on this card, so a clickable node could only be a tip.
        rule.onAllNodes(hasClickAction()).assertCountEquals(0)
    }
}
