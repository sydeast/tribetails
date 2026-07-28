package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Part-paid classification on Android. Mirrors the web
 * `src/lib/invoiceFormat.test.ts#invoicePartialPayment` cases so the two admin
 * surfaces cannot drift on what a part-paid invoice is.
 */
class InvoicePartPaidTest {
    private fun inv(
        status: String = "open",
        amountDue: Double = 20.0,
        total: Double = 40.0,
        paidCents: Long = 2000L,
    ) = Invoice(id = "i1", status = status, amountDue = amountDue, total = total, paidCents = paidCents)

    @Test
    fun `reports what was collected and what is left on a part-paid open invoice`() {
        val part = invoicePartPaid(inv())
        assertNotNull(part)
        assertEquals(2000L, part!!.paidCents)
        assertEquals(2000L, part.remainingCents)
    }

    @Test
    fun `is null for an open invoice nobody has paid`() {
        assertNull(invoicePartPaid(inv(amountDue = 40.0, paidCents = 0L)))
    }

    @Test
    fun `NEVER infers a payment from total minus amountDue`() {
        // On every invoice the pre-2026-07-25 write touched, amountDue reads 0.0
        // while a real balance is owed, so that subtraction reports the whole
        // total as collected on exactly the rows that are wrong. No paidCents
        // means no record of a payment, and no claim of one.
        assertNull(invoicePartPaid(inv(amountDue = 20.0, total = 40.0, paidCents = 0L)))
    }

    @Test
    fun `is null for every state other than OPEN, so it can never change an action set`() {
        for (status in listOf("paid", "draft", "quote", "cancelled", "credit", "redeemed", "zero")) {
            assertNull(invoicePartPaid(inv(status = status)))
        }
        // An UNSTAMPED doc: no stored state means no OPEN, so no part-paid
        // verdict either, however suggestive the money reads (ADR-0002).
        assertNull(invoicePartPaid(inv(status = "", amountDue = -25.0, total = -25.0)))
    }

    @Test
    fun `is null once nothing is left owing, however much was collected`() {
        assertNull(invoicePartPaid(inv(status = "open", amountDue = 0.0, total = 40.0, paidCents = 4000L)))
    }

    @Test
    fun `a part-paid invoice keeps the whole outstanding action set`() {
        // The guard that keeps collecting the balance possible at all: part-paid
        // is a display refinement of OPEN, so the actions are untouched.
        val actions = invoiceActionsFor(invoiceStateOrNull(inv()))
        assertTrue(actions.contains(InvoiceAction.RECORD_PAYMENT))
        assertTrue(actions.contains(InvoiceAction.SEND_REMINDER))
    }

    @Test
    fun `formatCentsUsd renders integer cents as money without float drift`() {
        assertEquals("$20.00", formatCentsUsd(2000L))
        assertEquals("$0.50", formatCentsUsd(50L))
        assertEquals("$0.05", formatCentsUsd(5L))
        assertEquals("$1234.56", formatCentsUsd(123456L))
        assertEquals("$0.00", formatCentsUsd(0L))
    }
}
