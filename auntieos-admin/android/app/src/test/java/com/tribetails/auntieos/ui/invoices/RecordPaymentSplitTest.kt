package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.model.Invoice
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

    // ── #1566: an Amount over the balance is tip, never applied ─────────────
    // The walk: INV-2026-0001, $78.50 owed, Amount 100, Fees 2.
    @Test
    fun `1566 blank payment amount - the invoice takes the balance and the rest is tip`() {
        assertEquals(
            PaymentSplit.Ok(paidCents = 10_000L, appliedCents = 7_850L, tipCents = 2_150L, creditCents = 0L, overCents = 2_150L),
            paymentSplit(100.0, tip = "", credit = "", paymentTotal = "", amountDueCents = 7_850L),
        )
    }
    @Test
    fun `1566 a typed tip is added to the part over the balance`() {
        val split = paymentSplit(100.0, tip = "5", credit = "", paymentTotal = "", amountDueCents = 7_850L) as PaymentSplit.Ok
        assertEquals(10_500L, split.paidCents)
        assertEquals(7_850L, split.appliedCents)
        assertEquals(2_650L, split.tipCents)
    }
    @Test
    fun `1566 typed payment amount with a blank tip puts everything past the balance in the tip`() {
        val split = paymentSplit(100.0, tip = "", credit = "", paymentTotal = "100", amountDueCents = 7_850L) as PaymentSplit.Ok
        assertEquals(7_850L, split.appliedCents)
        assertEquals(2_150L, split.tipCents)
        assertEquals(0L, split.creditCents)
    }
    @Test
    fun `1566 credit she types comes out of the part over the balance`() {
        val split = paymentSplit(100.0, tip = "", credit = "10", paymentTotal = "100", amountDueCents = 7_850L) as PaymentSplit.Ok
        assertEquals(7_850L, split.appliedCents)
        assertEquals(1_150L, split.tipCents)
        assertEquals(1_000L, split.creditCents)
    }
    @Test
    fun `1566 a typed tip that no longer adds up is refused and says why`() {
        val split = paymentSplit(100.0, tip = "21.50", credit = "", paymentTotal = "100", amountDueCents = 7_850L)
            as PaymentSplit.Refused
        assertTrue(split.message.contains("add up to \$121.50, not the \$100.00 paid"))
        assertTrue(split.message.contains("The invoice owes \$78.50, so \$21.50 of the amount counts as tip."))
    }
    @Test
    fun `1566 exactly the balance is unchanged`() {
        assertEquals(
            PaymentSplit.Ok(paidCents = 7_850L, appliedCents = 7_850L, tipCents = 0L, creditCents = 0L),
            paymentSplit(78.5, tip = "", credit = "", paymentTotal = "", amountDueCents = 7_850L),
        )
    }
    @Test
    fun `1566 an unknown balance caps nothing`() {
        // The ledger has not answered. The server refuses an over-balance amount
        // with what is owed; a stale zero must never make the whole payment tip.
        val split = paymentSplit(100.0, tip = "", credit = "", paymentTotal = "", amountDueCents = null) as PaymentSplit.Ok
        assertEquals(10_000L, split.appliedCents)
        assertEquals(0L, split.overCents)
    }
    @Test
    fun `1566 an invoice that owes nothing takes no payment`() {
        assertEquals(
            PaymentSplit.Refused("This invoice owes nothing, so no payment can be recorded against it."),
            paymentSplit(100.0, tip = "", credit = "", paymentTotal = "", amountDueCents = 0L),
        )
    }
    @Test
    fun `1566 the copy says the invoice takes the balance and the rest is tip, fee out of it`() {
        val split = paymentSplit(100.0, tip = "", credit = "", paymentTotal = "", amountDueCents = 7_850L)
        assertEquals(
            "\$100.00 paid: \$78.50 to this invoice, \$21.50 tip (the \$2.00 fee comes out of it), " +
                "\$0.00 account credit. The invoice owes \$78.50, so the \$21.50 over it is tip.",
            recordPaymentSplitCopy(split, feeCents = 200L),
        )
    }
    @Test
    fun `1566 the Record press settles with the balance and books the rest as gross tip`() {
        val invoice = Invoice(id = "inv1", kinfolkId = "fam1", invoiceNumber = "1001", amountDue = 78.5, total = 78.5)
        val split = paymentSplit(100.0, tip = "", credit = "", paymentTotal = "", amountDueCents = 7_850L) as PaymentSplit.Ok
        val (payment, applied) = recordPaymentSubmission(
            invoice = invoice,
            split = split,
            method = "venmo",
            reference = "",
            date = "2026-11-05",
            notes = "",
            fee = 2.0,
            sendConfirmation = false,
        )
        assertEquals(78.5, applied, 0.0)
        assertEquals(100.0, payment.amount, 0.0)
        assertEquals(21.5, payment.tip, 0.0)
        assertEquals(2.0, payment.fee, 0.0)
        assertEquals(0L, payment.creditToAccountCents)
        assertEquals(false, payment.autoApply)
    }
}
