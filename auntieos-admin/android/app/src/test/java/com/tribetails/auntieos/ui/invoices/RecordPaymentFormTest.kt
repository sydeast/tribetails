package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.repository.recordPaymentArgs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The record-payment form's own decisions: what a submitted payment carries,
 * and what the Unapplied Balance line says.
 *
 * PURE, so these run without Compose or Firebase. Everything the dialog decides
 * lives in `buildInvoicePayment` and `recordPaymentBalanceCopy` for exactly this
 * reason, the same split the rest of this screen already uses.
 */
class RecordPaymentFormTest {

    private fun invoice(
        amountDue: Double = 127.5,
        total: Double = 127.5,
    ) = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        kinfolkName = "The Riveras",
        invoiceNumber = "1029",
        amountDue = amountDue,
        total = total,
    )

    // ── What a submitted payment carries ──────────────────────────────────

    @Test
    fun `invoice 1029 carries the gross tip, the fee, and the whole transaction`() {
        val payment = buildInvoicePayment(
            invoice = invoice(),
            amount = 127.5,
            paymentMethod = "venmo",
            referenceNumber = "VN-1029",
            date = "2026-02-17",
            notes = "took the fee out of the tip",
            tip = 10.0,
            fee = 2.71,
        )
        // THE TRANSACTION, not the settlement: $127.50 settled the bill, the
        // client handed over $137.50.
        assertEquals(137.5, payment.amount, 0.0001)
        assertEquals(10.0, payment.tip, 0.0001)
        assertEquals(2.71, payment.fee, 0.0001)
        assertEquals("took the fee out of the tip", payment.notes)
    }

    @Test
    fun `an untouched tip and fee submit as zero, which is what a blank box means`() {
        val payment = buildInvoicePayment(invoice(), 127.5, "cash", "", "", "")
        assertEquals(127.5, payment.amount, 0.0001)
        assertEquals(0.0, payment.tip, 0.0001)
        assertEquals(0.0, payment.fee, 0.0001)
    }

    @Test
    fun `a stated payment total wins over amount plus tip, which is how a leftover is recorded`() {
        // $300 handed over against a $180 bill with no tip.
        val payment = buildInvoicePayment(
            invoice = invoice(amountDue = 180.0, total = 180.0),
            amount = 180.0,
            paymentMethod = "venmo",
            referenceNumber = "",
            date = "",
            notes = "",
            paymentTotal = 300.0,
        )
        assertEquals(300.0, payment.amount, 0.0001)
    }

    @Test
    fun `both switches default OFF, because each one does something to a real person`() {
        val payment = buildInvoicePayment(invoice(), 127.5, "cash", "", "", "")
        assertFalse(payment.autoApply)
        assertFalse(payment.sendConfirmationEmail)
    }

    @Test
    fun `the switches travel when they are turned on`() {
        val payment = buildInvoicePayment(
            invoice = invoice(),
            amount = 127.5,
            paymentMethod = "cash",
            referenceNumber = "",
            date = "",
            notes = "",
            autoApply = true,
            sendConfirmationEmail = true,
        )
        assertTrue(payment.autoApply)
        assertTrue(payment.sendConfirmationEmail)
    }

    @Test
    fun `the invoice link is still a DISPLAY link and never an apply`() {
        // `markInvoicePaid` runs first and has already settled the invoice by
        // the time this row is written. Sending an apply would put the same
        // money against the same bill a second time.
        val args = recordPaymentArgs(buildInvoicePayment(invoice(), 127.5, "cash", "", "", ""))
        assertEquals("inv1", args.invoiceId)
        assertEquals("1029", args.invoiceNumber)
        assertNull(args.apply)
        assertFalse(args.toPayload().containsKey("apply"))
    }

    @Test
    fun `every new field reaches the wire payload`() {
        val payload = recordPaymentArgs(
            buildInvoicePayment(
                invoice = invoice(),
                amount = 127.5,
                paymentMethod = "venmo",
                referenceNumber = "VN-1029",
                date = "2026-02-17",
                notes = "staff only",
                tip = 10.0,
                fee = 2.71,
                autoApply = true,
                sendConfirmationEmail = true,
            )
        ).toPayload()
        assertEquals(137.5, payload["amount"])
        assertEquals(10.0, payload["tip"])
        assertEquals(2.71, payload["fee"])
        assertEquals("staff only", payload["notes"])
        assertEquals(true, payload["autoApply"])
        assertEquals(true, payload["sendConfirmationEmail"])
    }

    // ── What the Unapplied Balance line says ──────────────────────────────

    @Test
    fun `it says nothing readable while a box is half-typed`() {
        // A figure derived from a number the dialog cannot read is worse than no
        // figure at all.
        assertTrue(recordPaymentBalanceCopy(null, false).contains("cannot be read"))
    }

    @Test
    fun `it reads zero on the ordinary payment, where nothing is left over`() {
        assertEquals("Unapplied balance $0.00.", recordPaymentBalanceCopy(0L, false))
    }

    @Test
    fun `it names the mis-key when more is applied than came in`() {
        val copy = recordPaymentBalanceCopy(-500L, false)
        assertTrue(copy.contains("does not cover"))
        assertTrue(copy.contains("Raise the payment amount"))
    }

    @Test
    fun `it says the leftover will be held as credit when auto-apply is on`() {
        val copy = recordPaymentBalanceCopy(12000L, true)
        assertTrue(copy.contains("$120.00"))
        assertTrue(copy.contains("account credit"))
    }

    @Test
    fun `it says the leftover will go nowhere when auto-apply is off`() {
        val copy = recordPaymentBalanceCopy(12000L, false)
        assertTrue(copy.contains("$120.00"))
        assertTrue(copy.contains("will not be applied"))
    }
}
