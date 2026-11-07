package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.contracts.decodePreviewInvoiceNoticeResult
import com.tribetails.auntieos.domain.noticePreviewSentence
import com.tribetails.auntieos.ui.invoices.linkPickerCancelled
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1609: the invoice list and link-picker fixes from the 2026-11-05 walk. */
class InvoiceMinorsTest {

    @Test
    fun `billed total leaves out drafts and quotes`() {
        val invoices = listOf(
            Invoice(id = "open", status = "open", total = 40.0),
            Invoice(id = "paid", status = "paid", total = 15.0),
            Invoice(id = "draft", status = "draft", total = 25.0),
            Invoice(id = "quote", status = "quote", total = 90.0),
        )
        assertEquals(55.0, invoiceBilledTotal(invoices), 0.0001)
    }

    @Test
    fun `under Only archived the hidden rows are called not archived`() {
        assertEquals(
            "2 of 2 shown. Tap a row to open the invoice. 18 invoices not archived hidden, counted within the invoices loaded here.",
            invoiceListSubtitle(2, 2, 18, ArchivedMode.Only),
        )
        assertEquals(
            "2 of 2 shown. Tap a row to open the invoice. 1 archived invoice hidden, counted within the invoices loaded here.",
            invoiceListSubtitle(2, 2, 1, ArchivedMode.Hide),
        )
    }

    @Test
    fun `a missing number reads as words`() {
        assertEquals("No number", invoiceNumberLabel(" "))
        assertEquals("#1020", invoiceNumberLabel("1020"))
    }

    @Test
    fun `a cancelled visit cannot be newly linked, but one already linked can be unlinked`() {
        val cancelled = KinCareSession(id = "s1").apply { status = "CANCELLED" }
        val done = KinCareSession(id = "s2").apply { status = "COMPLETED" }
        assertTrue(linkPickerCancelled(cancelled, emptyList()))
        assertFalse(linkPickerCancelled(cancelled, listOf("s1")))
        assertFalse(linkPickerCancelled(done, emptyList()))
    }
    @Test
    fun `the send confirm names the person and the channel`() {
        val preview = decodePreviewInvoiceNoticeResult(
            mapOf(
                "ok" to true,
                "hasRecipient" to true,
                "recipientName" to "Robin Wren",
                "email" to mapOf("on" to true, "address" to "catch@hanasamku.com"),
                "sms" to mapOf("on" to true, "address" to ""),
                "push" to mapOf("on" to false),
                "householdGateLive" to true,
            ),
        )
        assertEquals(
            "Goes to Robin Wren by email to catch@hanasamku.com, and in their notifications list. " +
                "Their account has no phone number on file.",
            noticePreviewSentence(preview),
        )
        assertEquals(
            "Household notices are paused before launch, so Robin Wren will not hear about this yet.",
            noticePreviewSentence(preview.copy(householdGateLive = false)),
        )
    }
}
