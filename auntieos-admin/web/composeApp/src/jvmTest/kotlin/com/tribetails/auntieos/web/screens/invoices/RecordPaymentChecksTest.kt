package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1975: the desktop Record payment questions a fee larger than the payment
 * and a tip larger than the invoice's total, in the same words as admin web
 * and Android.
 */
class RecordPaymentChecksTest {

    private val invoice = Invoice(
        _id = "inv1",
        kinfolkId = "kf1",
        kinfolkName = "Halbrook Household",
        invoiceNumber = "1042",
        total = 217.0,
        amountDue = 217.0,
        status = "sent",
    )

    private fun form(
        amount: String,
        apply: String = "217",
        tip: String = "",
        fee: String = "",
        confirmed: Long? = null,
    ) = parseRecordPaymentForm(invoice, amount, apply, tip, fee, "cash", "", "2026-11-21", "", "", false, confirmed)

    @Test
    fun aFeeLargerThanThePaymentIsRefusedOnTheLineAndOnRecord() {
        val message = "A fee of \$500.00 is more than the \$217.00 payment it came out of. Check the fee."
        assertEquals(RecordPaymentForm.Invalid(message), form("217", fee = "500"))
        assertEquals(message, recordPaymentSplitLine(recordPaymentSplit("217", "217", "", "", 21_700L), "500"))
        assertNull(feeOverPaymentError(21_700L, 21_700L))
    }

    @Test
    fun aFeeLargerThanTheTipComesOutOfThePaymentAndIsRecorded() {
        assertTrue(form("217", fee = "3") is RecordPaymentForm.Ready)
        assertEquals(
            "\$217.00 paid: \$217.00 to this invoice, \$0.00 tip (the \$3.00 fee comes out of the payment), \$0.00 account credit.",
            recordPaymentSplitLine(recordPaymentSplit("217", "217", "", "", 21_700L), "3"),
        )
        assertTrue(
            recordPaymentSplitLine(recordPaymentSplit("227", "217", "", "", 21_700L), "3")
                .contains("\$10.00 tip (the \$3.00 fee comes out of it)"),
        )
    }

    @Test
    fun aTipLargerThanTheInvoiceWaitsForTheTick() {
        // Seven 9s typed as the amount paid against a $217.00 invoice.
        assertEquals(RecordPaymentForm.Invalid(BIG_TIP_UNCONFIRMED), form("9999999"))
        val tipCents = 999_978_200L
        assertEquals(
            "The \$9,999,782.00 tip is right. It is more than this invoice's \$217.00 total.",
            bigTipConfirmLabel(tipCents, 21_700L),
        )
        val ready = form("9999999", confirmed = tipCents)
        assertTrue(ready is RecordPaymentForm.Ready, "$ready")
        assertEquals(9_999_782.0, ready.entry.payment.tip)
        // A tick for a different tip does not carry.
        assertEquals(RecordPaymentForm.Invalid(BIG_TIP_UNCONFIRMED), form("9999999", confirmed = 100L))
    }

    @Test
    fun aTipNoLargerThanTheInvoiceAsksNothing() {
        assertTrue(form("434") is RecordPaymentForm.Ready)
        assertTrue(!tipNeedsConfirming(21_700L, 21_700L))
        assertTrue(!tipNeedsConfirming(500L, null))
    }
}
