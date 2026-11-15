@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.screens.setThemedContent
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #2356, #2259: a tapped push or notifications row can name an invoice the household
 * cannot open (an unsent draft is hidden from Kinfolk; an invoice can be
 * removed). The screen says so in plain words and offers the way back. It
 * used to show a spinner that never ended.
 */
class InvoiceMissingTest {

    @Test
    fun says_the_invoice_is_no_longer_available_and_offers_the_way_back() = runComposeUiTest {
        var backs = 0
        setThemedContent { InvoiceMissing(onBackToInvoices = { backs += 1 }) }

        onNodeWithTag("invoice-missing").assertIsDisplayed()
        onNodeWithText("Invoice not found").assertIsDisplayed()
        onNodeWithText("This invoice is no longer available.").assertIsDisplayed()
        // Nothing of an invoice is drawn: no amount, no number, no pay button.
        onNodeWithText("Pay", substring = true).assertDoesNotExist()

        onNodeWithText("Back to Invoices").performClick()
        assertEquals(1, backs)
    }

    @Test
    fun a_failed_read_says_so_and_offers_another_try_instead_of_a_spinner() = runComposeUiTest {
        var retries = 0
        setThemedContent { InvoiceReadFailed(onRetry = { retries += 1 }) }
        onNodeWithTag("invoice-read-failed").assertIsDisplayed()
        onNodeWithText("Couldn't load this invoice").assertIsDisplayed()
        // Not the same as gone.
        onNodeWithText("Invoice not found").assertDoesNotExist()
        onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }
}
