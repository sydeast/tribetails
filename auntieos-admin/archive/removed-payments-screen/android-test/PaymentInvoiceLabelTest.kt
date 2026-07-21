package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Payment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Per-row payment->invoice link label (replaces the retired FF_PAYMENTS_INVOICE_LINK gate). */
class PaymentInvoiceLabelTest {

    @Test
    fun nullWhenUnlinked() {
        assertNull(paymentInvoiceLabel(Payment(id = "p1")))
        assertNull(paymentInvoiceLabel(Payment(id = "p1", invoiceId = "   ", invoiceNumber = "  ")))
    }

    @Test
    fun prefersInvoiceNumber() {
        assertEquals(
            "INV-100",
            paymentInvoiceLabel(Payment(invoiceId = "abc123def456", invoiceNumber = "INV-100")),
        )
    }

    @Test
    fun fallsBackToShortInvoiceId() {
        assertEquals(
            "abc123de",
            paymentInvoiceLabel(Payment(invoiceId = "abc123def456", invoiceNumber = "")),
        )
    }
}
