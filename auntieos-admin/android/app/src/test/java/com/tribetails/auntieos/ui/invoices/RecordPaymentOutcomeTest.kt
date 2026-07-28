package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.repository.InvoiceSettlement
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
 * The decodeInvoiceSettlement half of this file moved to InvoiceRepositoryTest
 * with the W4-1 carve: the decode is the repo's wire contract, while this file
 * is about the sentence the operator reads.
 */
class RecordPaymentOutcomeTest {

    private fun settlement(
        state: String,
        amountDueCents: Long = 0L,
        overpaidCents: Long = 0L,
    ) = InvoiceSettlement(
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
}
