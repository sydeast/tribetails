package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1256: the desktop invoice list row picks its one action from the stored
 * stamp through [invoiceActionsFor], as web and Android rows do. Before, a
 * cancelled, credit, redeemed or zero row with nothing owing, or a stamped open
 * bill whose `amountDue` reads 0, got a Receipt button. Decoded through the
 * desktop REST codec, the way the invoices stream reads them.
 *
 * #1258 (desktop half): the row's date line reads "paid" only for a paid one.
 */
class InvoiceRowActionTest {

    private val today = "2026-10-30"

    private fun decode(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    private fun row(status: String, amountDue: Double = 0.0, date: String = "2026-10-03", dueDate: String = "") =
        decode("""{"_id":"i1","status":"$status","total":40.0,"amountDue":$amountDue,"date":"$date","dueDate":"$dueDate"}""")

    @Test
    fun onlyAPaidRowOffersAReceipt() {
        assertEquals(InvoiceAction.GENERATE_RECEIPT, invoiceRowActionOrNull(row("paid")))
        for (status in listOf("cancelled", "credit", "redeemed", "zero", "quote", "sent", "")) {
            // Nothing owing does not make it paid: a receipt claims a payment.
            assertNull(invoiceRowActionOrNull(row(status, amountDue = 0.0)), status)
            assertNull(invoiceRowActionOrNull(row(status, amountDue = 40.0)), "$status with a balance")
        }
    }

    @Test
    fun anOpenBillWhoseAmountDueReadsZeroIsChasedNotReceipted() {
        // The pre-2026-07-25 write left amountDue at 0 on a real open balance.
        assertEquals(InvoiceAction.SEND_REMINDER, invoiceRowActionOrNull(row("open", amountDue = 0.0)))
        assertEquals(InvoiceAction.SEND_REMINDER, invoiceRowActionOrNull(row("OPEN ", amountDue = 40.0)))
    }

    @Test
    fun aDraftIsReviewedAndSent() {
        assertEquals(InvoiceAction.REVIEW_AND_SEND, invoiceRowActionOrNull(row("draft", amountDue = 40.0)))
    }

    @Test
    fun theRowNeverOffersRecordPayment() {
        for (state in InvoiceState.entries) {
            val action = invoiceRowActionOrNull(row(state.name.lowercase(), amountDue = 40.0))
            assert(action != InvoiceAction.RECORD_PAYMENT) { state.name }
            // Whatever the row offers, the detail screen's table offers too.
            if (action != null) assert(action in invoiceActionsFor(state)) { state.name }
        }
    }

    @Test
    fun theDateLineSaysPaidOnlyForAPaidInvoice() {
        assertEquals("paid Oct 3", invoiceRowDateLine(row("paid"), today))
        for (status in listOf("cancelled", "credit", "redeemed", "zero", "sent", "")) {
            assertEquals("dated Oct 3", invoiceRowDateLine(row(status), today), status)
        }
        // A cancelled bill keeps its dueDate; it is neither due nor paid.
        assertEquals("dated Oct 3", invoiceRowDateLine(row("cancelled", dueDate = "2026-11-01"), today))
    }

    @Test
    fun theDateLineForOpenQuoteDraftAndUndatedRows() {
        assertEquals("due Nov 15", invoiceRowDateLine(row("open", 40.0, dueDate = "2026-11-15"), today))
        assertEquals("1 day overdue", invoiceRowDateLine(row("open", 40.0, dueDate = "2026-10-29"), today))
        assertEquals("12 days overdue", invoiceRowDateLine(row("open", 40.0, dueDate = "2026-10-18"), today))
        assertEquals("paid Oct 3", invoiceRowDateLine(row("paid", dueDate = "2026-10-01"), today))
        assertEquals("quote", invoiceRowDateLine(row("quote", dueDate = "2026-10-01"), today))
        assertEquals("draft", invoiceRowDateLine(row("draft", dueDate = "2026-10-01"), today))
        assertEquals("no date", invoiceRowDateLine(row("paid", date = ""), today))
        assertEquals("due Nov 1", invoiceRowDateLine(row("cancelled", date = "", dueDate = "2026-11-01"), today))
    }
}
