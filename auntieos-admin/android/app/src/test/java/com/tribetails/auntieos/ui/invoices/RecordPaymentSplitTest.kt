package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.domain.PaymentSplit
import com.tribetails.auntieos.domain.paymentSplit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #988: where one payment goes, shown in the Record Payment dialog before Save.
 *
 * Operator ruling, 2026-09-27: an overpayment is all tip, the processor fee
 * comes out of the tip, and account credit is only ever an amount she enters.
 * Mirrors the `#988 paymentSplit` block in
 * `auntieos-admin/src/components/InvoiceDetail.test.tsx`.
 */
class RecordPaymentSplitTest {

    @Test
    fun `blank payment amount means applied plus tip plus credit`() {
        assertEquals(
            PaymentSplit.Ok(paidCents = 13_750L, appliedCents = 12_750L, tipCents = 1_000L, creditCents = 0L),
            paymentSplit(127.5, tip = "10", credit = "", paymentTotal = ""),
        )
    }

    @Test
    fun `a bigger payment with the tip left blank puts the whole leftover in the tip`() {
        assertEquals(
            PaymentSplit.Ok(paidCents = 20_000L, appliedCents = 12_750L, tipCents = 7_250L, creditCents = 0L),
            paymentSplit(127.5, tip = "", credit = "", paymentTotal = "200"),
        )
    }

    @Test
    fun `credit she enters comes out of the tip`() {
        assertEquals(
            PaymentSplit.Ok(paidCents = 20_000L, appliedCents = 12_750L, tipCents = 5_250L, creditCents = 2_000L),
            paymentSplit(127.5, tip = "", credit = "20", paymentTotal = "200"),
        )
    }

    @Test
    fun `the whole leftover may be left as credit`() {
        val split = paymentSplit(127.5, tip = "", credit = "72.50", paymentTotal = "200") as PaymentSplit.Ok
        assertEquals(0L, split.tipCents)
        assertEquals(7_250L, split.creditCents)
    }

    @Test
    fun `a credit one cent over the leftover is refused`() {
        val split = paymentSplit(127.5, tip = "", credit = "72.51", paymentTotal = "200")
        assertTrue(split is PaymentSplit.Refused)
        assertTrue((split as PaymentSplit.Refused).message.contains("more than the \$72.50 left"))
    }

    @Test
    fun `a typed tip and credit that do not add up to the payment are refused`() {
        val split = paymentSplit(127.5, tip = "10", credit = "20", paymentTotal = "200") as PaymentSplit.Refused
        assertTrue(split.message.contains("add up to \$157.50, not the \$200.00 paid"))
    }

    @Test
    fun `a payment smaller than the applied part is refused`() {
        val split = paymentSplit(127.5, tip = "", credit = "", paymentTotal = "100") as PaymentSplit.Refused
        assertTrue(split.message.contains("does not cover"))
    }

    @Test
    fun `half-typed boxes give no split at all`() {
        assertNull(paymentSplit(127.5, tip = "abc", credit = "", paymentTotal = ""))
        assertNull(paymentSplit(127.5, tip = "", credit = "-5", paymentTotal = ""))
        assertNull(paymentSplit(127.5, tip = "", credit = "", paymentTotal = "x"))
    }

    // ── What the dialog says ─────────────────────────────────────────────────

    @Test
    fun `the copy says where every dollar goes and that the fee comes out of the tip`() {
        val split = paymentSplit(127.5, tip = "", credit = "20", paymentTotal = "200")
        assertEquals(
            "\$200.00 paid: \$127.50 to this invoice, \$52.50 tip (the \$2.71 fee comes out of it), " +
                "\$20.00 account credit.",
            recordPaymentSplitCopy(split, feeCents = 271L),
        )
    }

    @Test
    fun `no fee clause when there is no fee`() {
        assertEquals(
            "\$127.50 paid: \$127.50 to this invoice, \$0.00 tip, \$0.00 account credit.",
            recordPaymentSplitCopy(paymentSplit(127.5, "", "", ""), feeCents = 0L),
        )
    }

    @Test
    fun `a refusal is shown as it is, and a half-typed box as not yet`() {
        val refused = paymentSplit(127.5, tip = "", credit = "80", paymentTotal = "200")
        assertEquals((refused as PaymentSplit.Refused).message, recordPaymentSplitCopy(refused, null))
        assertTrue(recordPaymentSplitCopy(null, null).contains("cannot be read"))
    }
}
