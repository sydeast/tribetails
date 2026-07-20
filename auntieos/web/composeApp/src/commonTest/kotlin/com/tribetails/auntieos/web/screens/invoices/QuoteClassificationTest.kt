package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * PART B: a quote is an invoice in QUOTE status. invoiceIsQuote classifies off
 * the free-text `status` field (createQuote stamps status="QUOTE"), and a quote
 * must never be mis-bucketed as a payable invoice.
 */
class QuoteClassificationTest {

    @Test
    fun quoteStatusClassifiesAsQuote() {
        assertTrue(invoiceIsQuote(Invoice(status = "QUOTE")))
        assertTrue(invoiceIsQuote(Invoice(status = "quote")))
        assertTrue(invoiceIsQuote(Invoice(status = " Quote ")))
    }

    @Test
    fun nonQuoteStatusesAreNotQuotes() {
        assertFalse(invoiceIsQuote(Invoice(status = "draft")))
        assertFalse(invoiceIsQuote(Invoice(status = "sent")))
        assertFalse(invoiceIsQuote(Invoice(status = "paid")))
        assertFalse(invoiceIsQuote(Invoice(status = "")))
    }

    @Test
    fun quoteIsNotClassifiedAsDraft() {
        val q = Invoice(status = "QUOTE", amountDue = 100.0)
        assertTrue(invoiceIsQuote(q))
        assertFalse(invoiceIsDraft(q))
    }

    @Test
    fun outstandingQuoteStillReadsOutstandingButQuoteWins() {
        // amountDue>0 makes it "outstanding" by the money test, but the screen
        // checks invoiceIsQuote first so a quote never shows in payable buckets.
        val q = Invoice(status = "QUOTE", amountDue = 100.0)
        assertTrue(invoiceIsOutstanding(q))
        assertTrue(invoiceIsQuote(q))
    }
}
