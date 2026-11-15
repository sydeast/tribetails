@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.invoices

import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
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

    /** The route's own wiring: the read, the three states, and the retry. */
    @androidx.compose.runtime.Composable
    private fun Route(held: () -> Boolean, failed: () -> Boolean, read: suspend () -> Unit) {
        val state = rememberInvoiceRead(invoiceId = "inv1", held = held, read = read)
        when (invoiceDetailView(found = held(), freshlyRead = state.freshlyRead, readFailed = failed())) {
            InvoiceDetailView.Invoice -> androidx.compose.material3.Text("THE INVOICE")
            InvoiceDetailView.Missing -> InvoiceMissing(onBackToInvoices = {})
            InvoiceDetailView.Failed -> InvoiceReadFailed(onRetry = state::retry)
            InvoiceDetailView.Loading -> androidx.compose.material3.Text("LOADING")
        }
    }
    @Test
    fun try_again_reads_again_and_shows_the_invoice_when_that_read_lands() = runComposeUiTest {
        var held by androidx.compose.runtime.mutableStateOf(false)
        var failed by androidx.compose.runtime.mutableStateOf(false)
        var reads = 0
        setThemedContent {
            Route(held = { held }, failed = { failed }, read = {
                reads += 1
                // The first read fails; the second finds the invoice.
                if (reads == 1) failed = true else { failed = false; held = true }
            })
        }
        waitForIdle()
        onNodeWithTag("invoice-read-failed").assertIsDisplayed()
        onNodeWithText("Try again").performClick()
        waitForIdle()
        assertEquals(2, reads)
        onNodeWithText("THE INVOICE").assertIsDisplayed()
        onNodeWithTag("invoice-read-failed").assertDoesNotExist()
        onNodeWithText("LOADING").assertDoesNotExist()
    }
    @Test
    fun try_again_that_fails_again_says_so_again_and_never_stays_on_the_spinner() = runComposeUiTest {
        var failed by androidx.compose.runtime.mutableStateOf(false)
        var reads = 0
        setThemedContent { Route(held = { false }, failed = { failed }, read = { reads += 1; failed = true }) }
        waitForIdle()
        onNodeWithText("Try again").performClick()
        waitForIdle()
        assertEquals(2, reads)
        onNodeWithTag("invoice-read-failed").assertIsDisplayed()
        onNodeWithText("LOADING").assertDoesNotExist()
    }
    @Test
    fun an_invoice_a_fresh_read_does_not_hold_ends_on_not_found_after_one_read() = runComposeUiTest {
        var reads = 0
        setThemedContent { Route(held = { false }, failed = { false }, read = { reads += 1 }) }
        waitForIdle()
        assertEquals(1, reads)
        onNodeWithTag("invoice-missing").assertIsDisplayed()
    }
    @Test
    fun an_invoice_already_in_hand_is_not_read_again() = runComposeUiTest {
        var reads = 0
        setThemedContent { Route(held = { true }, failed = { false }, read = { reads += 1 }) }
        waitForIdle()
        assertEquals(0, reads)
        onNodeWithText("THE INVOICE").assertIsDisplayed()
    }
}
