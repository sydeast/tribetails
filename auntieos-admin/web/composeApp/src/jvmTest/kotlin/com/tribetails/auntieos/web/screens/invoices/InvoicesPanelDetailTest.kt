package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.material3.Text
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.DenPanel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1595, the inverse case of the subtitle ruling: the Invoices panel's count
 * ("3 of 12 shown") is a value, so it is drawn under the title where it can be
 * read, not folded into the info tip with an explanation.
 */
@OptIn(ExperimentalTestApi::class)
class InvoicesPanelDetailTest {

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun theCountReadsAsAValue() {
        assertEquals("3 of 12 shown", invoicesShownDetail(3, 12))
    }

    @Test
    fun aPanelDetailIsDrawnInPlainSight() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                DenPanel(title = "Invoices", detail = invoicesShownDetail(3, 12)) {
                    Text("rows")
                }
            }
        }
        waitUntil(timeoutMillis = 10_000) { shown("Invoices") }
        assertTrue(shown("3 of 12 shown"), "the count is on screen without opening a tip")
    }
}
