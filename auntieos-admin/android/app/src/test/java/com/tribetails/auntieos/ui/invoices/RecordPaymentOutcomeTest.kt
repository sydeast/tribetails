package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.contracts.MarkInvoicePaidResult
import com.tribetails.auntieos.data.contracts.decodeMarkInvoicePaidResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the operator is TOLD after recording a payment.
 *
 * The UI half of the 2026-07-25 defect: a payment covering half an invoice
 * reported "Payment recorded." with no hint that a balance remained, so the
 * operator had no way to tell from the screen that anything was still owed.
 *
 * The decode half of this file moved to InvoiceRepositoryTest with the W4-1
 * carve, and then out of the repo entirely with ADR-0001 adoption: the wire
 * shape is the generated `MarkInvoicePaidResult` now. This file is about the
 * sentence the operator reads, which is where the unreadable-state ruling ended
 * up living.
 */
class RecordPaymentOutcomeTest {

    private fun settlement(
        state: String,
        amountDueCents: Long = 0L,
        overpaidCents: Long = 0L,
    ) = MarkInvoicePaidResult(
        ok = true,
        invoiceId = "inv1",
        paymentId = "pay1",
        state = state,
        totalCents = 4000L,
        paidCents = 4000L - amountDueCents,
        amountDueCents = amountDueCents,
        overpaidCents = overpaidCents,
    )

    @Test
    fun `a partial says what is still owed and that the invoice stays open`() {
        val msg = recordPaymentToast(settlement("partial", amountDueCents = 2000L))
        assertTrue(msg, msg.contains("$20.00"))
        assertTrue(msg, msg.contains("still owed"))
        assertTrue(msg, msg.contains("stays open"))
        assertFalse(msg, msg.contains("paid in full"))
    }

    @Test
    fun `a settling payment says paid in full`() {
        val msg = recordPaymentToast(settlement("settled"))
        assertTrue(msg, msg.contains("paid in full"))
    }

    @Test
    fun `an overpayment names the excess and says it was not turned into a credit`() {
        val msg = recordPaymentToast(settlement("overpaid", overpaidCents = 50L))
        assertTrue(msg, msg.contains("$0.50"))
        assertTrue(msg, msg.contains("not been turned into a credit"))
    }

    @Test
    fun `the audit line distinguishes a partial from a settlement`() {
        val partial = recordPaymentAuditDescription(20.0, "INV-9", settlement("partial", amountDueCents = 2000L))
        assertTrue(partial, partial.contains("partial payment"))
        assertTrue(partial, partial.contains("still owed"))

        val settled = recordPaymentAuditDescription(40.0, "INV-9", settlement("settled"))
        assertTrue(settled, settled.contains("settled"))
        assertFalse(settled, settled.contains("partial"))
    }

    // ── the unreadable-state ruling (ADR-0001 adoption) ──────────────────────

    @Test
    fun `an unreadable markInvoicePaid response carries a blank state, not a guessed one`() {
        // THE TWO READINGS, side by side. The deleted hand-decoder answered
        // "partial" for each of these; the generated decoder answers "". The
        // schema settles which is right: `state` is a required four-member enum
        // the server builds from settleInvoice on every path, so there is no
        // absent case for a default to describe, and "partial" was the client
        // inventing a settlement position nobody sent. Note amountDueCents too:
        // the old pairing said "partial" while every cents figure decoded to 0,
        // so the sentence it produced claimed a part-payment with nothing
        // outstanding.
        val unreadable = decodeMarkInvoicePaidResult(null)
        assertEquals("", unreadable.state)
        assertEquals(0L, unreadable.amountDueCents)
        assertEquals("", decodeMarkInvoicePaidResult(emptyMap()).state)
        assertEquals("", decodeMarkInvoicePaidResult(mapOf("state" to "")).state)
        assertEquals("", decodeMarkInvoicePaidResult(mapOf("state" to 7)).state)
    }

    @Test
    fun `a blank state says the position is unknown, claiming neither settlement nor a balance`() {
        val msg = recordPaymentToast(settlement(""))
        // Not the claim the 2026-07-25 fix exists to stop the app making.
        assertFalse(msg, msg.contains("paid in full"))
        // And not the fabricated balance the old fail-soft produced either.
        assertFalse(msg, msg.contains("$0.00"))
        assertFalse(msg, msg.contains("Partial"))
        assertTrue(msg, msg.contains("Payment recorded"))
        assertTrue(msg, msg.contains("open it to check"))
    }

    @Test
    fun `a blank state audits the payment without recording a settlement that was never reported`() {
        val line = recordPaymentAuditDescription(20.0, "INV-9", settlement(""))
        assertTrue(line, line.contains("Recorded payment of 20.0"))
        assertFalse(line, line.contains("settled"))
        assertFalse(line, line.contains("partial"))
    }

    @Test
    fun `every state the server can send reads exactly as it did before adoption`() {
        // The ruling changed ONE input's answer. The four members of the
        // settlement enum are untouched, `unpaid` included: it shares the
        // settled sentence today and is left alone on purpose, because
        // re-deciding it is a product question rather than a contracts one.
        assertTrue(recordPaymentToast(settlement("partial", amountDueCents = 100L)).contains("still owed"))
        assertTrue(recordPaymentToast(settlement("overpaid", overpaidCents = 100L)).contains("overpaid by"))
        assertEquals(
            recordPaymentToast(settlement("settled")),
            recordPaymentToast(settlement("unpaid")),
        )
    }
}
