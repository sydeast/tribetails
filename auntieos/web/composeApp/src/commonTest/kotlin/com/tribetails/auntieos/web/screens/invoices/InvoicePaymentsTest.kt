package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Payment
import kotlin.test.Test
import kotlin.test.assertEquals

/** Per-invoice payment join + prefilled-payment builder (spec 17 items 5/6). */
class InvoicePaymentsTest {

    private fun payment(id: String, invoiceId: String, kinfolkId: String) =
        Payment(_id = id, invoiceId = invoiceId, kinfolkId = kinfolkId)

    @Test
    fun filtersByInvoiceId() {
        val ps = listOf(
            payment("p1", "inv1", "k1"),
            payment("p2", "inv2", "k1"),
            payment("p3", "inv1", "k2"),
        )
        assertEquals(listOf("p1", "p3"), paymentsForInvoice(ps, "inv1").map { it._id })
        assertEquals(emptyList(), paymentsForInvoice(ps, ""))
    }

    @Test
    fun buildStampsInvoiceLinkAndTrims() {
        val inv = Invoice(_id = "inv1", kinfolkId = "k1", kinfolkName = "Thorne", invoiceNumber = "TT-1", amountDue = 280.0)
        val p = buildInvoicePayment(inv, 280.0, " card ", " PMT-1 ", " 2026-05-24 ", " paid in full ")
        assertEquals("inv1", p.invoiceId)
        assertEquals("TT-1", p.invoiceNumber)
        assertEquals("k1", p.kinfolkId)
        assertEquals("Thorne", p.kinfolkName)
        assertEquals(280.0, p.amount, 0.0)
        assertEquals("card", p.paymentMethod)
        assertEquals("PMT-1", p.referenceNumber)
        assertEquals("2026-05-24", p.date)
        assertEquals("paid in full", p.notes)
    }
}
