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
    fun `2092 a quote is headed Quote, sent or saved unsent, and an accepted one is an Invoice`() {
        assertEquals("Quote #1026", invoiceDocTitle(inv("quote").copy(invoiceNumber = "1026")))
        assertEquals("Quote #1026", invoiceDocTitle(inv("draft", quoteDraft = true).copy(invoiceNumber = "1026")))
        assertEquals("Invoice #1026", invoiceDocTitle(inv("open", quoteDecision = "accepted").copy(invoiceNumber = "1026")))
        assertEquals("Invoice #1042", invoiceDocTitle(inv("draft").copy(invoiceNumber = "1042")))
        assertEquals("Invoice #-", invoiceDocTitle(inv("open")))
    }

    @Test
    fun `2092 the draft panel says Kinfolk, never client`() {
        assertEquals("This invoice is still a draft. Review it, then send it to let the Kinfolk know.", draftPanelLine(false))
        assertFalse(draftPanelLine(false).contains("client"))
        assertTrue(draftPanelLine(true).startsWith("This quote is saved but not sent"))
    }

    @Test
    fun `2087 a quote saved but not sent is told apart from every other refusal by its code`() {
        assertEquals("q1", quoteSavedNotSentId(mapOf("code" to "quote_saved_not_sent", "invoiceId" to "q1")))
        assertEquals(null, quoteSavedNotSentId(mapOf("code" to "quote_saved_not_sent", "invoiceId" to "")))
        assertEquals(null, quoteSavedNotSentId(mapOf("code" to "session_on_other_invoice", "invoiceId" to "q1")))
        assertEquals(null, quoteSavedNotSentId(null))
        assertEquals(null, quoteSavedNotSentId("quote_saved_not_sent"))
    }

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
            archiveSuccessMessage(restoring = false, released = 1, quote = true),
        )
        assertEquals("Invoice archived.", archiveSuccessMessage(restoring = false))
    }

    @Test
    fun `restoring promises an answer only for a sent quote nobody has answered`() {
        val archived = "2026-11-12"
        assertEquals(RESTORE_QUOTE_CONFIRM_COPY, restoreQuoteConfirmCopy(inv("quote", archivedAt = archived)))
        // Saved unsent: it comes back as the hidden draft it was.
        val draft = restoreQuoteConfirmCopy(inv("draft", quoteDraft = true, archivedAt = archived))
        assertTrue(draft.contains("as a draft. The household still cannot see it until you send it."))
        assertFalse(draft.contains("answer it again"))
        // Declined: back in view, still declined, holding no visits.
        val declined = restoreQuoteConfirmCopy(inv("quote", quoteDecision = "denied", archivedAt = archived))
        assertTrue(declined.contains("as declined"))
        assertFalse(declined.contains("answer it again"))
        assertFalse(declined.contains("takes back the visits"))
        assertEquals(
            "Quote restored as a draft. The household cannot see it until you send it.",
            archiveSuccessMessage(restoring = true, quote = true, quoteDraft = true),
        )
        assertEquals(
            "Quote restored. The household can see it again.",
            archiveSuccessMessage(restoring = true, quote = true),
        )
    }

    @Test
    fun `the Archived banner on a quote never says the household can still see it`() {
        val archived = "2026-11-12"
        for (quote in listOf(
            inv("quote", archivedAt = archived),
            inv("draft", quoteDraft = true, archivedAt = archived),
            inv("quote", quoteDecision = "denied", archivedAt = archived),
        )) {
            val text = archivedQuoteBannerCopy(quote)
            assertTrue(text.startsWith("This quote is out of the working list."))
            assertFalse(text.contains("still see it"))
        }
        assertTrue(archivedQuoteBannerCopy(inv("draft", quoteDraft = true, archivedAt = archived)).contains("never sent"))
    }
}
