package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultOpenInvoice
import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultPayment
import com.tribetails.auntieos.data.contracts.ResolveUnappliedPaymentResult
import java.time.ZoneId
import java.time.ZonedDateTime
import org.junit.Assert.assertEquals
import org.junit.Test

/** #1003: the Decide form and the payment lines, shared wording with web and desktop. */
class UnappliedPaymentTest {

    private val zone = ZoneId.of("America/Chicago")
    private fun ms(y: Int, m: Int, d: Int) = ZonedDateTime.of(y, m, d, 12, 0, 0, 0, zone).toInstant().toEpochMilli()

    private val payment = ListUnappliedPaymentsResultPayment(
        paymentId = "evt_1",
        kinfolkId = "fam1",
        invoiceId = "inv42",
        invoiceNumber = "INV-1042",
        amountCents = 2500L,
        amountResolved = true,
        feeCents = 103L,
        reason = "the invoice was already marked paid",
        receivedAtMs = ms(2026, 9, 27),
        referenceNumber = "pi_1",
    )
    private val inv50 = ListUnappliedPaymentsResultOpenInvoice("inv50", "INV-1050", 4000L)
    private val inv51 = ListUnappliedPaymentsResultOpenInvoice("inv51", "INV-1051", 1000L)
    private val open = listOf(inv50, inv51)

    private fun form(credit: String = "", reason: String = "", invoice: String = "", apply: String = "") =
        parseDecideForm(2500L, open, credit, reason, invoice, apply)

    @Test
    fun `row and dialog lines`() {
        assertEquals("$25.00 card payment on invoice INV-1042", unappliedPaymentHeadline(payment))
        assertEquals(
            "Sep 27, 2026. Not applied because the invoice was already marked paid.",
            unappliedPaymentDetail(payment, zone),
        )
        assertEquals(
            "Card payment of $25.00 on invoice INV-1042. There are no refunds. " +
                "Anything you do not credit or apply stays recorded on the payment.",
            decidePaymentLead(payment),
        )
        assertEquals("INV-1050, $40.00 due", openInvoiceOptionLabel(inv50))
    }

    @Test
    fun `a reason that already ends in a period is not doubled`() {
        assertEquals(
            "Sep 27, 2026. Not applied because it was a duplicate.",
            unappliedPaymentDetail(payment.copy(reason = "it was a duplicate."), zone),
        )
    }

    @Test
    fun `blank fields are zero - keep it all as recorded`() {
        assertEquals(DecideForm.Ready(0L, "", "", 0L, 2500L), form())
        assertEquals("Credit $0.00, apply $0.00, keep $25.00.", decideSummaryLine(form() as DecideForm.Ready))
    }

    @Test
    fun `credit and apply split, reason trimmed, summary line`() {
        val f = form(credit = "10", reason = "  Overpaid  ", invoice = "inv50", apply = "15.00")
        assertEquals(DecideForm.Ready(1000L, "Overpaid", "inv50", 1500L, 0L), f)
        assertEquals("Credit $10.00, apply $15.00, keep $0.00.", decideSummaryLine(f as DecideForm.Ready))
    }

    @Test
    fun `no credit sends no reason, no apply sends no invoice`() {
        assertEquals(DecideForm.Ready(0L, "", "", 0L, 2500L), form(reason = "typed but unused", invoice = "inv50"))
        assertEquals(DecideForm.Ready(0L, "", "", 0L, 2500L), form(invoice = "inv50", apply = "0"))
    }

    @Test
    fun `each refusal, one bad input at a time`() {
        assertEquals(DecideForm.Invalid(DECIDE_BAD_AMOUNT), form(credit = "-1", reason = "r"))
        assertEquals(DecideForm.Invalid(DECIDE_BAD_AMOUNT), form(credit = "1.234", reason = "r"))
        assertEquals(DecideForm.Invalid(DECIDE_BAD_AMOUNT), form(credit = "abc", reason = "r"))
        assertEquals(DecideForm.Invalid(DECIDE_BAD_AMOUNT), form(invoice = "inv50", apply = "-2"))
        assertEquals(DecideForm.Invalid(DECIDE_NEED_REASON), form(credit = "5", reason = "   "))
        assertEquals(DecideForm.Invalid(DECIDE_NEED_INVOICE), form(apply = "5"))
        assertEquals(DecideForm.Invalid(DECIDE_NEED_INVOICE), form(invoice = "gone", apply = "5"))
        assertEquals(DecideForm.Invalid(DECIDE_OVER_PAYMENT), form(credit = "20", reason = "r", invoice = "inv50", apply = "5.01"))
        assertEquals(DecideForm.Invalid(DECIDE_OVER_PAYMENT), form(credit = "25.01", reason = "r"))
        assertEquals(DecideForm.Invalid("That invoice owes only $10.00."), form(invoice = "inv51", apply = "10.01"))
    }

    @Test
    fun `the refusal strings are the spec's words`() {
        assertEquals("Enter an amount in dollars, like 12.50.", DECIDE_BAD_AMOUNT)
        assertEquals("The credit and the applied amount add up to more than this payment.", DECIDE_OVER_PAYMENT)
        assertEquals("Enter a reason for the credit.", DECIDE_NEED_REASON)
        assertEquals("Choose an invoice for the applied amount.", DECIDE_NEED_INVOICE)
        assertEquals("That invoice owes only $40.00.", decideInvoiceOwesOnly(4000L))
        assertEquals("No open invoices for this household.", NO_OPEN_INVOICES_TEXT)
    }

    private fun result(
        credited: Long = 0L,
        applied: Long = 0L,
        state: String = "",
        due: Long = 0L,
        kept: Long = 0L,
        balance: Long = 0L,
    ) = ResolveUnappliedPaymentResult(
        ok = true, paymentId = "evt_1", kinfolkId = "fam1", paymentCents = 2500L,
        creditedCents = credited, creditId = "", appliedCents = applied,
        appliedInvoiceId = if (applied > 0) "inv50" else "", appliedInvoiceNumber = if (applied > 0) "INV-1050" else "",
        appliedInvoiceState = state, appliedInvoiceAmountDueCents = due, keptCents = kept,
        newAccountBalanceCents = balance, replayed = false,
    )

    @Test
    fun `result note - every part`() {
        assertEquals(
            "Decision saved. $10.00 to account credit (balance now $37.00). " +
                "$15.00 on invoice INV-1050 (paid in full). $0.00 kept on the payment.",
            decisionResultText(result(credited = 1000, applied = 1500, state = "settled", balance = 3700)),
        )
    }

    @Test
    fun `result note - partial invoice shows what is still due, from the server`() {
        assertEquals(
            "Decision saved. $15.00 on invoice INV-1050 ($12.00 still due). $10.00 kept on the payment.",
            decisionResultText(result(applied = 1500, state = "partial", due = 1200, kept = 1000)),
        )
    }

    @Test
    fun `result note - keep only omits the credit and invoice sentences`() {
        assertEquals(
            "Decision saved. $25.00 kept on the payment.",
            decisionResultText(result(kept = 2500)),
        )
    }
}
