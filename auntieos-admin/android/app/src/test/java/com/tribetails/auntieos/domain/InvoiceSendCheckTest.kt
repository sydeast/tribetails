package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/** #1567: twin of the web's lib/invoiceSendCheck.test.ts; the sentences must match. */
class InvoiceSendCheckTest {
    private val draft = SendMarks("draft", null, null, null)
    @Test
    fun `reads the raw doc case-blind, and every stamp shape`() {
        val marks = sendMarksOf(
            mapOf(
                "status" to " Open ",
                "reminderNotifiedAtMs" to 1_700_000_000_000L,
                "receiptIssuedAt" to com.google.firebase.Timestamp(1_700_000_000, 500_000_000),
                "quoteResentAt" to "not a time",
            ),
        )
        assertEquals(SendMarks("open", 1_700_000_000_000L, 1_700_000_000_500L, null), marks)
    }
    @Test
    fun `the model gives status and the reminder stamp, nothing it cannot vouch for`() {
        val marks = sendMarksOf(Invoice(id = "i", status = "Draft", reminderNotifiedAtMs = 5L))
        assertEquals(SendMarks("draft", 5L, null, null), marks)
    }
    @Test
    fun `a draft send landed only when the status left draft`() {
        assertTrue(sendLanded(SendCheckAction.REVIEW_SEND, draft, draft.copy(status = "open")))
        assertFalse(sendLanded(SendCheckAction.REVIEW_SEND, draft, draft))
        assertFalse(sendLanded(SendCheckAction.REVIEW_SEND, draft, draft.copy(status = "")))
    }
    @Test
    fun `reminder, receipt and quote resend landed only when their own stamp moved`() {
        val before = SendMarks("open", 100L, 7L, 9L)
        assertFalse(sendLanded(SendCheckAction.REMINDER, before, before))
        assertTrue(sendLanded(SendCheckAction.REMINDER, before, before.copy(reminderNotifiedAtMs = 200L)))
        assertFalse(sendLanded(SendCheckAction.RECEIPT, before, before))
        assertTrue(sendLanded(SendCheckAction.RECEIPT, before, before.copy(receiptIssuedAtMs = 8L)))
        assertFalse(sendLanded(SendCheckAction.RESEND_QUOTE, before, before))
        assertTrue(sendLanded(SendCheckAction.RESEND_QUOTE, before, before.copy(quoteResentAtMs = 10L)))
    }
    @Test
    fun `the three sentences match the web word for word`() {
        assertEquals(
            SilenceOutcome(SilenceKind.SENT, "Draft sent. The answer came late, so this was confirmed by re-reading the invoice."),
            sendOutcomeAfterSilence(SendCheckAction.REVIEW_SEND, 70, draft, draft.copy(status = "open")),
        )
        assertEquals(
            SilenceOutcome(
                SilenceKind.NOT_SENT,
                "Tribe Tails did not answer within 70 seconds. The invoice is still a draft, so it has not gone out. Send it again.",
            ),
            sendOutcomeAfterSilence(SendCheckAction.REVIEW_SEND, 70, draft, draft),
        )
        val unknown = sendOutcomeAfterSilence(SendCheckAction.REMINDER, 70, draft, null)
        assertEquals(SilenceKind.UNKNOWN, unknown.kind)
        assertTrue(unknown.message.contains("no way to tell from here whether the reminder went"))
        // A failed "before" read is just as unknowable as a failed "after".
        assertEquals(SilenceKind.UNKNOWN, sendOutcomeAfterSilence(SendCheckAction.RECEIPT, 70, null, draft).kind)
    }
}
