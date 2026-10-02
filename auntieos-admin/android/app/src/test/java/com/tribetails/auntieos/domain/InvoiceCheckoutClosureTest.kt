package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
/**
 * The open-payment-links line on the invoice detail (#1113), pinned to the same
 * reading as the web `invoiceCheckoutClosure` in `src/api/invoices.ts`.
 */
class InvoiceCheckoutClosureTest {
    private fun invoice(sweep: Any?) = Invoice(id = "inv1", status = "paid", checkoutSweep = sweep)
    @Test
    fun `no sweep record means no line`() {
        assertNull(invoiceCheckoutClosureOrNull(invoice(null)))
        assertNull(invoiceCheckoutClosureOrNull(invoice("junk")))
    }
    @Test
    fun `a sweep that expired nothing and failed nothing means no line`() {
        assertNull(invoiceCheckoutClosureOrNull(invoice(mapOf("expiredIds" to emptyList<String>(), "failed" to emptyList<Any>()))))
    }
    @Test
    fun `counts expired ids and reads Stripe's reason`() {
        val c = invoiceCheckoutClosureOrNull(
            invoice(
                mapOf(
                    "expiredIds" to listOf("cs_a", "cs_b"),
                    "failed" to listOf(mapOf("sessionId" to "cs_c", "reason" to "No.")),
                ),
            ),
        )!!
        assertEquals(2, c.closedCount)
        assertEquals(listOf(InvoiceCheckoutFailure("cs_c", "No.")), c.failed)
    }
    @Test
    fun `a failure for a session the server has since closed is not shown`() {
        val inv = Invoice(
            id = "inv1",
            checkoutSweep = mapOf(
                "expiredIds" to listOf("cs_a"),
                "failed" to listOf(mapOf("sessionId" to "cs_c", "reason" to "No.")),
            ),
            closedCheckoutSessionIds = listOf("cs_a", "cs_c"),
        )
        assertEquals(InvoiceCheckoutClosure(1, emptyList()), invoiceCheckoutClosureOrNull(inv))
    }
    @Test
    fun `junk entries are dropped rather than trusted`() {
        val c = invoiceCheckoutClosureOrNull(
            invoice(
                mapOf(
                    "expiredIds" to listOf("cs_a", 7, null),
                    "failed" to listOf(mapOf("sessionId" to 3), "x", mapOf("sessionId" to "cs_c")),
                ),
            ),
        )!!
        assertEquals(1, c.closedCount)
        assertEquals(listOf(InvoiceCheckoutFailure("cs_c", "Stripe refused the request.")), c.failed)
    }
    @Test
    fun `the closed line carries the count`() {
        val c = InvoiceCheckoutClosure(closedCount = 2, failed = emptyList())
        assertEquals("Open payment links closed (2)", checkoutClosureLine(c))
    }
    @Test
    fun `a failure line gives Stripe's reason in plain words`() {
        val one = InvoiceCheckoutClosure(0, listOf(InvoiceCheckoutFailure("cs_c", "You cannot expire this Checkout Session.")))
        assertEquals(
            "Could not close an open payment link: You cannot expire this Checkout Session.",
            checkoutClosureLine(one),
        )
        val two = InvoiceCheckoutClosure(
            0,
            listOf(InvoiceCheckoutFailure("a", "Stripe is down."), InvoiceCheckoutFailure("b", "Other.")),
        )
        assertEquals("Could not close 2 open payment links: Stripe is down.", checkoutClosureLine(two))
    }
}
