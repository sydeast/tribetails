package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.repository.InvoiceSettlement
import com.tribetails.auntieos.data.repository.decodeInvoiceSettlement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the operator is TOLD after recording a payment, and how the callable's
 * answer is decoded.
 *
 * The UI half of the 2026-07-25 defect: a payment covering half an invoice
 * reported "Payment recorded." with no hint that a balance remained, so the
 * operator had no way to tell from the screen that anything was still owed.
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

    @Test
    fun `decodes the callable payload into integer cents`() {
        val decoded = decodeInvoiceSettlement(
            mapOf(
                "state" to "partial",
                "totalCents" to 4000,
                "paidCents" to 2000,
                "amountDueCents" to 2000,
                "overpaidCents" to 0,
            ),
        )
        assertEquals("partial", decoded.state)
        assertEquals(2000L, decoded.amountDueCents)
        assertTrue(decoded.isPartial)
    }

    @Test
    fun `an UNREADABLE payload decodes to partial, never to settled`() {
        // If the server's answer cannot be read, the safe reading is that money
        // may still be owed: that keeps the invoice in Outstanding and keeps the
        // operator able to collect. Defaulting to settled would reproduce the
        // very defect this change removes, in the client.
        assertTrue(decodeInvoiceSettlement(null).isPartial)
        assertTrue(decodeInvoiceSettlement(emptyMap()).isPartial)
        assertTrue(decodeInvoiceSettlement(mapOf("state" to "")).isPartial)
    }

    @Test
    fun `a missing cents field decodes to zero rather than throwing`() {
        val decoded = decodeInvoiceSettlement(mapOf("state" to "settled"))
        assertEquals(0L, decoded.amountDueCents)
        assertEquals(0L, decoded.overpaidCents)
    }
}
