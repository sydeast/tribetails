package com.tribetails.auntieos.web.data
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
/**
 * #1567: the desktop half of "a send that got no answer is re-read, never
 * reported as failed". Twin of the web's lib/invoiceSendCheck.test.ts and
 * Android's InvoiceSendCheckTest; the sentences must match.
 */
class InvoiceSendCheckTest {
    private val draft = SendMarks("draft", null, null, null)
    private val open = draft.copy(status = "open")
    @Test
    fun `reads the plain document case-blind, stamps as the text they arrived as`() {
        val doc = buildJsonObject {
            put("status", JsonPrimitive(" Open "))
            put("reminderNotifiedAtMs", JsonPrimitive(1_700_000_000_000L))
            put("receiptIssuedAt", JsonPrimitive("2026-11-05T21:47:42Z"))
        }
        assertEquals(SendMarks("open", "1700000000000", "2026-11-05T21:47:42Z", null), sendMarksOf(doc))
    }
    @Test
    fun `each send is judged by its own mark moving`() {
        assertTrue(sendLanded(SendCheckAction.REVIEW_SEND, draft, open))
        assertFalse(sendLanded(SendCheckAction.REVIEW_SEND, draft, draft))
        val before = SendMarks("open", "1", "a", "x")
        assertFalse(sendLanded(SendCheckAction.REMINDER, before, before))
        assertTrue(sendLanded(SendCheckAction.REMINDER, before, before.copy(reminderStamp = "2")))
        assertTrue(sendLanded(SendCheckAction.RECEIPT, before, before.copy(receiptStamp = "b")))
        assertTrue(sendLanded(SendCheckAction.RESEND_QUOTE, before, before.copy(quoteResentStamp = "y")))
    }
    @Test
    fun `a timed-out send that landed reads as sent`() = runBlocking {
        var reads = 0
        val checked = checkedSend(SendCheckAction.REVIEW_SEND, { if (reads++ == 0) draft else open }) {
            WriteResult.Err(AUNTIE_TIMEOUT_MESSAGE)
        }
        val silent = assertIs<CheckedSend.Silent>(checked)
        assertEquals(
            SilenceOutcome(SilenceKind.SENT, "Draft sent. The answer came late, so this was confirmed by re-reading the invoice."),
            silent.outcome,
        )
        assertEquals(2, reads)
    }
    @Test
    fun `a timed-out send that did not land says not sent, naming the console's budget`() = runBlocking {
        val checked = checkedSend(SendCheckAction.REVIEW_SEND, { draft }) { WriteResult.Err(AUNTIE_TIMEOUT_MESSAGE) }
        val silent = assertIs<CheckedSend.Silent>(checked)
        assertEquals(
            "Tribe Tails did not answer within 90 seconds. The invoice is still a draft, so it has not gone out. Send it again.",
            silent.outcome.message,
        )
    }
    @Test
    fun `a failed re-read says it cannot tell`() = runBlocking {
        val checked = checkedSend(SendCheckAction.REMINDER, { null }) { WriteResult.Err(AUNTIE_TIMEOUT_MESSAGE) }
        val silent = assertIs<CheckedSend.Silent>(checked)
        assertEquals(SilenceKind.UNKNOWN, silent.outcome.kind)
        assertTrue(silent.outcome.message.contains("no way to tell from here whether the reminder went"))
    }
    @Test
    fun `a server refusal passes through untouched and is not re-read`() = runBlocking {
        var reads = 0
        val refusal = WriteResult.Err("Invoice is not a draft; nothing to send.")
        val checked = checkedSend(SendCheckAction.REVIEW_SEND, { reads++; draft }) { refusal }
        assertEquals(CheckedSend.Answered(refusal), checked)
        assertEquals(1, reads)
    }
}
