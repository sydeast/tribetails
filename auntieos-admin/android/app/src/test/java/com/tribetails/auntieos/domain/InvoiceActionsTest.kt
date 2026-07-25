package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shared invoice classifier + action gating both invoice surfaces read.
 * Mirrors the web `src/lib/invoiceFormat.test.ts` cases for `invoiceState`,
 * `isInvoiceOverdue`, and `invoiceActionsFor`.
 */
class InvoiceActionsTest {
    private fun inv(
        status: String = "",
        amountDue: Double = 0.0,
        total: Double = 0.0,
        dueDate: String = "",
    ) = Invoice(id = "i1", status = status, amountDue = amountDue, total = total, dueDate = dueDate)

    // ── classification ────────────────────────────────────────────────────────

    @Test
    fun `explicit status labels win, case and whitespace insensitive`() {
        assertEquals(InvoiceState.QUOTE, invoiceStateOf(inv(status = " QUOTE ")))
        assertEquals(InvoiceState.DRAFT, invoiceStateOf(inv(status = "Draft")))
        assertEquals(InvoiceState.CANCELLED, invoiceStateOf(inv(status = "cancelled")))
        assertEquals(InvoiceState.PAID, invoiceStateOf(inv(status = "paid", total = 40.0)))
    }

    @Test
    fun `a negative balance is a credit even with no label (the AO-12 defect)`() {
        // The old list helper called this PAID by negation, and the old detail
        // screen called it PAID because amountDue <= 0.
        assertEquals(InvoiceState.CREDIT, invoiceStateOf(inv(amountDue = -20.0, total = -20.0)))
        assertEquals(InvoiceState.CREDIT, invoiceStateOf(inv(status = "credit", amountDue = -20.0)))
    }

    @Test
    fun `an unlabeled row is placed by its money fields`() {
        assertEquals(InvoiceState.OPEN, invoiceStateOf(inv(amountDue = 40.0, total = 40.0)))
        assertEquals(InvoiceState.PAID, invoiceStateOf(inv(amountDue = 0.0, total = 40.0)))
        // Nothing was ever billed. NOT a claim that someone paid.
        assertEquals(InvoiceState.ZERO, invoiceStateOf(inv(amountDue = 0.0, total = 0.0)))
    }

    @Test
    fun `a draft with a zero balance is still a draft, never paid`() {
        assertEquals(InvoiceState.DRAFT, invoiceStateOf(inv(status = "draft", amountDue = 0.0, total = 0.0)))
    }

    @Test
    fun `non-finite money reads as no evidence rather than tipping a comparison`() {
        assertEquals(InvoiceState.ZERO, invoiceStateOf(inv(amountDue = Double.NaN, total = Double.NaN)))
    }

    // ── overdue ───────────────────────────────────────────────────────────────

    @Test
    fun `overdue only applies to an open invoice past its due date`() {
        assertTrue(invoiceIsOverdue(inv(amountDue = 40.0, total = 40.0, dueDate = "2026-07-01"), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(amountDue = 40.0, total = 40.0, dueDate = "2026-08-01"), "2026-07-16"))
    }

    @Test
    fun `a draft, quote, credit or paid invoice is never overdue, however stale its due date`() {
        val stale = "2020-01-01"
        assertFalse(invoiceIsOverdue(inv(status = "draft", amountDue = 40.0, dueDate = stale), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(status = "quote", amountDue = 40.0, dueDate = stale), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(status = "credit", amountDue = -5.0, dueDate = stale), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(status = "paid", total = 40.0, dueDate = stale), "2026-07-16"))
    }

    @Test
    fun `an unparseable due date never fabricates an overdue verdict`() {
        assertFalse(invoiceIsOverdue(inv(amountDue = 40.0, total = 40.0, dueDate = "Net 14"), "2026-07-16"))
        assertFalse(invoiceIsOverdue(inv(amountDue = 40.0, total = 40.0, dueDate = "07/01/2026"), "2026-07-16"))
    }

    // ── the action matrix ─────────────────────────────────────────────────────

    @Test
    fun `a paid invoice offers a receipt and nothing else (the reported bug)`() {
        assertEquals(listOf(InvoiceAction.GENERATE_RECEIPT), invoiceActionsFor(InvoiceState.PAID))
    }

    @Test
    fun `an open invoice offers the two collection actions, never a receipt`() {
        val actions = invoiceActionsFor(InvoiceState.OPEN)
        assertTrue(InvoiceAction.SEND_REMINDER in actions)
        assertTrue(InvoiceAction.RECORD_PAYMENT in actions)
        assertFalse(InvoiceAction.GENERATE_RECEIPT in actions)
        assertFalse(InvoiceAction.REVIEW_AND_SEND in actions)
    }

    @Test
    fun `a draft offers review-and-send only`() {
        assertEquals(listOf(InvoiceAction.REVIEW_AND_SEND), invoiceActionsFor(InvoiceState.DRAFT))
    }

    @Test
    fun `a quote has no payment actions`() {
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.QUOTE))
    }

    @Test
    fun `cancelled, credit and zero-balance rows have no actions`() {
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.CANCELLED))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.CREDIT))
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsFor(InvoiceState.ZERO))
    }

    @Test
    fun `the matrix is total, every state resolves to a set`() {
        for (state in InvoiceState.values()) {
            assertNotNull("no action set for $state", invoiceActionsFor(state))
        }
    }

    @Test
    fun `the matrix never overlaps, no state both collects and receipts`() {
        for (state in InvoiceState.values()) {
            val actions = invoiceActionsFor(state)
            val collecting =
                InvoiceAction.SEND_REMINDER in actions || InvoiceAction.RECORD_PAYMENT in actions
            assertFalse("$state offers both", collecting && InvoiceAction.GENERATE_RECEIPT in actions)
        }
    }

    @Test
    fun `an overdue invoice gets exactly the open set, overdue is not its own bucket`() {
        val overdueInvoice = inv(amountDue = 40.0, total = 40.0, dueDate = "2020-01-01")
        assertTrue(invoiceIsOverdue(overdueInvoice, "2026-07-16"))
        assertEquals(
            invoiceActionsFor(InvoiceState.OPEN),
            invoiceActionsFor(invoiceStateOf(overdueInvoice)),
        )
    }

    @Test
    fun `a stale-dated draft cannot pick up a payment action`() {
        val staleDraft = inv(status = "draft", amountDue = 40.0, total = 40.0, dueDate = "2020-01-01")
        assertEquals(listOf(InvoiceAction.REVIEW_AND_SEND), invoiceActionsFor(invoiceStateOf(staleDraft)))
    }
}
