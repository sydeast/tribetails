package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1200: what the operator sees in the desktop invoice "How to pay" panel.
 * The resolution rules are pinned in `HowToPayRowsTest`; this pins that the
 * panel renders those rows and nothing else.
 */
@OptIn(ExperimentalTestApi::class)
class HowToPayPanelRenderTest {

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, substring = true, ignoreCase = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private val settings = BusinessSettings(
        venmoHandle = "@tribetails",
        paymentOptions = buildJsonObject {
            putJsonObject("venmo") { put("enabled", false) }
            putJsonObject("zelle") { put("enabled", true); put("instructions", "Zelle to the business line.") }
        },
    )

    @Test
    fun theOfferedMethodsRenderAndASwitchedOffHandleDoesNot() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                HowToPayPanel(invoice = Invoice(_id = "inv1", status = "open", amountDue = 60.0), settings = settings)
            }
        }
        waitUntil(timeoutMillis = 10_000) { shown("How to pay") }
        assertTrue(shown("Credit card"), "card row")
        assertTrue(shown("In the portal"), "card detail")
        assertTrue(shown("Zelle to the business line."), "Zelle instructions")
        assertFalse(shown("@tribetails"), "Venmo is switched off, so its kept handle stays hidden")
        assertFalse(shown("Send payment to any of these"), "no explanatory subtitle")
    }

    @Test
    fun aPaidInvoiceRendersNoPanel() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                HowToPayPanel(invoice = Invoice(_id = "inv1", status = "paid"), settings = settings)
            }
        }
        waitForIdle()
        assertFalse(shown("How to pay"), "nothing to pay on a paid invoice")
    }
}
