package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1258: the invoice list row's date line reads the stored state. "paid" is a
 * claim that money came in, so only a PAID invoice gets it; every other dated
 * row reads "dated", as the web list does.
 */
class InvoiceRowDateLineTest {

    private val today = "2026-10-30"

    private fun inv(status: String, date: String = "2026-10-03", dueDate: String = "", amountDue: Double = 0.0) =
        Invoice(id = "i1", status = status, date = date, dueDate = dueDate, amountDue = amountDue)

    @Test
    fun onlyAPaidInvoiceReadsPaid() {
        assertEquals("paid Oct 3", invoiceRowDateLine(inv("paid"), today))
        for (status in listOf("cancelled", "credit", "redeemed", "zero", "sent", "")) {
            assertEquals(status, "dated Oct 3", invoiceRowDateLine(inv(status), today))
        }
    }

    @Test
    fun aClosedRowWithADueDateStillDoesNotReadPaid() {
        // A cancelled bill keeps its dueDate; it is not due and it was not paid.
        assertEquals("dated Oct 3", invoiceRowDateLine(inv("cancelled", dueDate = "2026-11-01"), today))
    }

    @Test
    fun anOpenBillReadsDueOrOverdue() {
        assertEquals("due Nov 15", invoiceRowDateLine(inv("open", dueDate = "2026-11-15", amountDue = 40.0), today))
        assertEquals("1 day overdue", invoiceRowDateLine(inv("open", dueDate = "2026-10-29", amountDue = 40.0), today))
        assertEquals("12 days overdue", invoiceRowDateLine(inv("open", dueDate = "2026-10-18", amountDue = 40.0), today))
    }

    @Test
    fun aStaleDueDateOnAPaidInvoiceIsNotOverdue() {
        assertEquals("paid Oct 3", invoiceRowDateLine(inv("paid", dueDate = "2026-10-01"), today))
    }

    @Test
    fun quotesDraftsAndUndatedRows() {
        assertEquals("quote", invoiceRowDateLine(inv("quote", dueDate = "2026-10-01"), today))
        assertEquals("draft", invoiceRowDateLine(inv("draft", dueDate = "2026-10-01"), today))
        assertEquals("no date", invoiceRowDateLine(inv("paid", date = ""), today))
        assertEquals("due Nov 1", invoiceRowDateLine(inv("cancelled", date = "", dueDate = "2026-11-01"), today))
    }
}
