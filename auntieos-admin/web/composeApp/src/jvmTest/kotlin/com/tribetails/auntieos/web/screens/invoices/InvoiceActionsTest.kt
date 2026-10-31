package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1238: the desktop invoice detail offers Record payment and Generate receipt
 * from the stored stamp, through the same table web and Android use. Before,
 * both buttons showed on every invoice whatever its state.
 */
class InvoiceActionsTest {

    private val today = "2026-10-30"

    private fun decode(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    private fun actionsOf(invoice: Invoice) = invoiceActionsFor(invoiceDetailBadgeFor(invoice, today).state)

    @Test
    fun everyStateGetsWebAndAndroidsActions() {
        val expected = mapOf(
            InvoiceState.OPEN to listOf(InvoiceAction.SEND_REMINDER, InvoiceAction.RECORD_PAYMENT),
            InvoiceState.PAID to listOf(InvoiceAction.GENERATE_RECEIPT),
            InvoiceState.DRAFT to listOf(InvoiceAction.REVIEW_AND_SEND),
            InvoiceState.QUOTE to emptyList(),
            InvoiceState.CANCELLED to emptyList(),
            InvoiceState.CREDIT to emptyList(),
            InvoiceState.REDEEMED to emptyList(),
            InvoiceState.ZERO to emptyList(),
        )
        assertEquals(InvoiceState.entries.toSet(), expected.keys)
        for ((state, actions) in expected) assertEquals(actions, invoiceActionsFor(state), state.name)
        assertEquals(emptyList(), invoiceActionsFor(null))
    }

    @Test
    fun onlyAStoredOpenBillOffersRecordPayment() {
        for (status in listOf("paid", "cancelled", "quote", "draft", "credit", "redeemed", "zero", "sent", "")) {
            // A balance on the doc does not make it a bill to collect.
            val inv = decode("""{"_id":"i1","status":"$status","total":40.0,"amountDue":40.0}""")
            assertFalse(InvoiceAction.RECORD_PAYMENT in actionsOf(inv), status)
        }
        assertTrue(InvoiceAction.RECORD_PAYMENT in actionsOf(decode("""{"_id":"i1","status":"OPEN ","amountDue":40.0}""")))
    }

    @Test
    fun onlyAStoredPaidInvoiceOffersAReceipt() {
        for (status in listOf("open", "cancelled", "quote", "draft", "credit", "redeemed", "zero", "")) {
            // Not even with a zero balance: a receipt claims a payment.
            val inv = decode("""{"_id":"i1","status":"$status","total":40.0,"amountDue":0.0}""")
            assertFalse(InvoiceAction.GENERATE_RECEIPT in actionsOf(inv), status)
        }
        assertTrue(InvoiceAction.GENERATE_RECEIPT in actionsOf(decode("""{"_id":"i1","status":"paid","amountDue":0.0}""")))
    }

    @Test
    fun overdueAndPartPaidKeepTheOpenSet() {
        val overduePartPaid = decode(
            """{"_id":"i1","status":"open","total":40.0,"amountDue":25.0,"paidCents":1500,"dueDate":"2026-10-01"}""",
        )
        val badge = invoiceDetailBadgeFor(overduePartPaid, today)
        assertTrue(badge.overdue)
        assertEquals(listOf(InvoiceAction.SEND_REMINDER, InvoiceAction.RECORD_PAYMENT), invoiceActionsFor(badge.state))
    }

    @Test
    fun theReminderRuleReadsTheSameTable() {
        for (state in InvoiceState.entries) {
            val inv = Invoice(_id = "i1", status = state.name.lowercase(), amountDue = 40.0)
            assertEquals(InvoiceAction.SEND_REMINDER in invoiceActionsFor(state), invoiceIsRemindable(inv), state.name)
        }
        assertFalse(invoiceIsRemindable(Invoice(_id = "i1", status = "sent", amountDue = 40.0)))
    }

    @Test
    fun theEmptyPaymentsLinePointsAtRecordPaymentOnlyWhenItIsOffered() {
        assertEquals(
            "No payment recorded against this invoice yet. Use Record payment to log one.",
            invoicePaymentsEmptyCopy(invoiceActionsFor(InvoiceState.OPEN)),
        )
        for (state in InvoiceState.entries - InvoiceState.OPEN) {
            assertEquals("No payment recorded against this invoice.", invoicePaymentsEmptyCopy(invoiceActionsFor(state)), state.name)
        }
        assertEquals("No payment recorded against this invoice.", invoicePaymentsEmptyCopy(invoiceActionsFor(null)))
    }
}
