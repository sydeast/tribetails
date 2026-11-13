package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.ui.invoices.archiveSuccessMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2087 / #2088 / #2195: which quotes the office can still change, and what the
 * screen says about it. The server is the enforcement; this pins the offer.
 */
class InvoiceQuoteTest {

    private fun inv(
        status: String,
        quoteDraft: Boolean? = null,
        quoteDecision: String? = null,
        archivedAt: Any? = null,
    ) = Invoice(id = "i1", status = status, quoteDraft = quoteDraft, quoteDecision = quoteDecision, archivedAt = archivedAt)

    @Test
    fun `a draft carrying the quote mark is a quote saved unsent, and an ordinary draft is not`() {
        assertTrue(isQuoteDraft(inv("draft", quoteDraft = true)))
        assertFalse(isQuoteDraft(inv("draft")))
        assertFalse(isQuoteDraft(inv("draft", quoteDraft = false)))
        // The mark means nothing once the doc is no longer a draft.
        assertFalse(isQuoteDraft(inv("quote", quoteDraft = true)))
    }

    @Test
    fun `a quote saved unsent, waiting for an answer or declined can be turned or withdrawn`() {
        assertTrue(quoteIsChangeable(inv("draft", quoteDraft = true)))
        assertTrue(quoteIsChangeable(inv("quote")))
        assertTrue(quoteIsChangeable(inv("quote", quoteDecision = "denied")))
    }

    @Test
    fun `an accepted quote, an archived one and an ordinary invoice cannot`() {
        assertFalse(quoteIsChangeable(inv("open", quoteDecision = "accepted")))
        assertFalse(quoteIsChangeable(inv("quote", archivedAt = "2026-11-12")))
        assertFalse(quoteIsChangeable(inv("draft")))
        assertFalse(quoteIsChangeable(inv("open")))
        assertFalse(quoteIsChangeable(inv("cancelled")))
        // Restoring the archived quote would make it changeable again.
        assertTrue(quoteIsChangeableOnRestore(inv("quote", archivedAt = "2026-11-12")))
    }

    @Test
    fun `the toasts say what happened in plain words`() {
        assertEquals("Quote sent. The household can accept or decline it now.", quoteSentMessage(false))
        assertEquals(
            "Quote withdrawn. The household no longer sees it, and its 2 visits are back on the not yet invoiced list.",
            quoteWithdrawnMessage(2),
        )
        assertEquals("Quote withdrawn. The household no longer sees it.", quoteWithdrawnMessage(0))
        assertEquals(
            "Quote archived. The household no longer sees it. Its visit is back on the un-invoiced list.",
            archiveSuccessMessage(restoring = false, force = false, released = 1, quote = true),
        )
        assertEquals("Invoice archived.", archiveSuccessMessage(restoring = false, force = false))
    }
}
