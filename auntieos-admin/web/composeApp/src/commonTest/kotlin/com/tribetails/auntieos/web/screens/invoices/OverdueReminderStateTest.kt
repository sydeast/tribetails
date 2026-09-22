package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #871: the desktop console's Overdue pill, detail badge and Send reminder button
 * agree with the server. Only a stored `open` bill is overdue or remindable,
 * whatever its `amountDue` says, exactly as the server's `invoiceOverdueCron` and
 * `sendInvoiceReminder` decide and as web and Android already render.
 */
class OverdueReminderStateTest {

    private val today = "2026-09-14"
    private val stale = "2026-09-01"

    private fun inv(status: String, amountDue: Double = 40.0, dueDate: String = stale) =
        Invoice(_id = "i1", status = status, amountDue = amountDue, total = 40.0, dueDate = dueDate)

    @Test
    fun allEightStoredStatesDecodeAndAnythingElseIsNull() {
        val expected = mapOf(
            "quote" to InvoiceState.QUOTE, "draft" to InvoiceState.DRAFT,
            "cancelled" to InvoiceState.CANCELLED, "credit" to InvoiceState.CREDIT,
            "redeemed" to InvoiceState.REDEEMED, "paid" to InvoiceState.PAID,
            "zero" to InvoiceState.ZERO, "open" to InvoiceState.OPEN,
        )
        for ((status, state) in expected) assertEquals(state, invoiceStateOrNull(inv(status)))
        assertEquals(InvoiceState.OPEN, invoiceStateOrNull(inv(" Open ")))
        assertNull(invoiceStateOrNull(inv("")))
        assertNull(invoiceStateOrNull(inv("sent")))
        assertNull(invoiceStateOrNull(inv("overdue")))
    }

    @Test
    fun onlyAStoredOpenBillIsOverdueOrRemindable() {
        for (state in InvoiceState.entries) {
            val i = inv(state.name.lowercase())
            val open = state == InvoiceState.OPEN
            assertEquals(open, invoiceIsOverdue(i, today), "overdue for $state")
            assertEquals(open, invoiceIsRemindable(i), "remindable for $state")
            assertEquals(
                if (open) InvoiceStatus.OVERDUE else InvoiceStatus.OUTSTANDING,
                invoiceStatusFor(i, today),
                "detail status for $state",
            )
        }
    }

    @Test
    fun theIssueShapesWithABalanceAndAPastDateAreNeverOverdueOrRemindable() {
        for (status in listOf("cancelled", "quote", "QUOTE", "draft", "credit")) {
            val i = inv(status, amountDue = 90.0)
            assertFalse(invoiceIsOverdue(i, today), status)
            assertFalse(invoiceIsRemindable(i), status)
            assertNull(daysOverdue(i, today), status)
        }
    }

    @Test
    fun anUnstampedOrHandLabelledDocIsNeverOverdue() {
        assertFalse(invoiceIsOverdue(inv(""), today))
        assertFalse(invoiceIsOverdue(inv("past_due"), today))
        assertFalse(invoiceIsRemindable(inv("sent")))
    }

    @Test
    fun dueTodayIsDueNotOverdue() {
        assertFalse(invoiceIsOverdue(inv("open", dueDate = today), today))
        assertTrue(invoiceIsOverdue(inv("open", dueDate = "2026-09-13"), today))
        assertEquals(13, daysOverdue(inv("open"), today))
        assertEquals(InvoiceStatus.OUTSTANDING, invoiceStatusFor(inv("open", dueDate = today), today))
    }

    @Test
    fun aPaidInvoiceStillReadsPaidOnTheDetailBadge() {
        assertEquals(InvoiceStatus.PAID, invoiceStatusFor(inv("paid", amountDue = 0.0), today))
        assertFalse(invoiceIsRemindable(inv("paid", amountDue = 0.0)))
    }
}
