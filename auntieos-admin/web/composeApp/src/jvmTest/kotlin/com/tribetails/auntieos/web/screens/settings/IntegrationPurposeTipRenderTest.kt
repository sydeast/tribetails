package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.AUNTIE_INFO_TIP_TAG
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1759: the desktop Integrations panel drew each add-on's purpose, and Stripe
 * Connect's, as a standing line under the name. The 2026-09-11 ruling ("at most
 * they can be tool tips") puts it behind the info tip beside the name, as web's
 * `TitleWithTip` and Android's `IntegrationCard` do. The name stays a node of
 * its own and the tip's content description carries the purpose.
 */
@OptIn(ExperimentalTestApi::class)
class IntegrationPurposeTipRenderTest {

    private val addOnPurpose = "Automate workflows across thousands of apps"
    private val connectPurpose = "Online payments, invoices, and payouts"
    private val connectHint = "Connecting needs your Stripe Connect client ID + secret (operator-provided)."

    @Test
    fun addOnPurposeIsATipNotALine() = runDesktopComposeUiTest {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { AddOnComingSoon("Zapier", addOnPurpose) } }
        assertEquals(0, onAllNodesWithText(addOnPurpose, substring = true, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(1, onAllNodesWithContentDescription(addOnPurpose, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(1, onAllNodesWithTag(AUNTIE_INFO_TIP_TAG).fetchSemanticsNodes().size)
        onNodeWithText("Zapier").assertTextEquals("Zapier")
    }

    @Test
    fun stripeConnectPurposeIsATipAndTheHintStillStands() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                Column { IntegrationNeedsKeysRow("Stripe Connect", connectPurpose, connectHint) }
            }
        }
        assertEquals(0, onAllNodesWithText(connectPurpose, substring = true, useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(1, onAllNodesWithContentDescription(connectPurpose, useUnmergedTree = true).fetchSemanticsNodes().size)
        onNodeWithText("Stripe Connect").assertTextEquals("Stripe Connect")
        // The hint is what to do next, the report slot Android keeps standing too.
        onNodeWithText(connectHint).assertTextEquals(connectHint)
    }

    @Test
    fun blankPurposeDrawsNoTip() = runDesktopComposeUiTest {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { AddOnComingSoon("Make", "") } }
        assertEquals(0, onAllNodesWithTag(AUNTIE_INFO_TIP_TAG).fetchSemanticsNodes().size)
        onNodeWithText("Make").assertTextEquals("Make")
    }
}
