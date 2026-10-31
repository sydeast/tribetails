package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import kotlinx.serialization.builtins.ListSerializer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1240: the desktop invoice detail shows PART PAID from the stored
 * `paidCents`, ranked below OVERDUE, names "$X of $Y paid", and a bad
 * `paidCents` never drops the invoice from the list. Decoded through the
 * desktop REST codec, the way the invoices stream reads them.
 */
class InvoicePartPaidTest {

    private val today = "2026-10-30"

    private fun decode(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    private fun open(paidCents: String, amountDue: Double = 20.0, dueDate: String = "2026-11-15", status: String = "open") =
        decode(
            """{"_id":"i1","status":"$status","total":40.0,"amountDue":$amountDue,"dueDate":"$dueDate","paidCents":$paidCents}""",
        )

    // ── Decode ───────────────────────────────────────────────────────────────

    @Test
    fun aBadPaidCentsNeverDropsTheInvoiceFromTheList() {
        val list = JvmFirestoreRest.codec.decodeFromString(
            ListSerializer(Invoice.serializer()),
            """[
              {"_id":"a","status":"open","paidCents":"2000"},
              {"_id":"b","status":"open","paidCents":null},
              {"_id":"c","status":"open","paidCents":{"oops":1}},
              {"_id":"d","status":"open","paidCents":[1,2]},
              {"_id":"e","status":"open","paidCents":true},
              {"_id":"f","status":"open"}
            ]""",
        )
        assertEquals(listOf("a", "b", "c", "d", "e", "f"), list.map { it._id })
        list.forEach { assertNull(invoicePaidCentsOf(it), it._id) }
    }

    @Test
    fun onlyAWholeNumberReadsAsPaidCents() {
        assertEquals(2000L, invoicePaidCentsOf(open("2000")))
        assertEquals(2000L, invoicePaidCentsOf(open("2000.0")))
        // Never rounded into a claim the doc does not make.
        assertNull(invoicePaidCentsOf(open("12.5")))
        assertNull(invoicePaidCentsOf(open("\"2000\"")))
    }

    // ── Refinement ───────────────────────────────────────────────────────────

    @Test
    fun anOpenInvoiceWithAPaymentAndABalanceIsPartPaid() {
        val part = invoicePartPaidOf(open("2000", amountDue = 20.0))
        assertEquals(InvoicePartPayment(paidCents = 2000L, remainingCents = 2000L), part)
    }

    @Test
    fun noOtherStateIsPartPaid() {
        for (status in listOf("paid", "draft", "quote", "cancelled", "credit", "redeemed", "zero", "", "sent")) {
            assertNull(invoicePartPaidOf(open("2000", status = status)), status)
        }
    }

    @Test
    fun noPaymentOrNoBalanceIsNotPartPaid() {
        assertNull(invoicePartPaidOf(open("0")))
        assertNull(invoicePartPaidOf(open("-500")))
        assertNull(invoicePartPaidOf(open("null")))
        assertNull(invoicePartPaidOf(open("2000", amountDue = 0.0)))
        assertNull(invoicePartPaidOf(open("2000", amountDue = 0.004)))
        // Absent: no record of a payment, so no claim of one.
        assertNull(invoicePartPaidOf(decode("""{"_id":"i1","status":"open","total":40.0,"amountDue":20.0}""")))
    }

    // ── Badge ────────────────────────────────────────────────────────────────

    @Test
    fun thePartPaidBadgeNamesBothFigures() {
        val b = invoiceDetailBadgeFor(open("1500", amountDue = 25.0), today)
        assertEquals("PART PAID", b.label)
        assertEquals(AuntieStatusTone.Purple, b.tone)
        assertEquals(InvoiceState.OPEN, b.state)
        assertEquals("$15.00 of $40.00 paid", b.amountTrend)
        assertEquals("Still owed", invoiceAmountDueLabelFor(b))
    }

    @Test
    fun overdueOutranksPartPaidButTheTrendStillNamesThePayment() {
        val b = invoiceDetailBadgeFor(open("1500", amountDue = 25.0, dueDate = "2026-10-01"), today)
        assertEquals("OVERDUE", b.label)
        assertTrue(b.overdue)
        assertEquals("$15.00 of $40.00 paid", b.amountTrend)
        assertEquals("Still owed", invoiceAmountDueLabelFor(b))
    }

    @Test
    fun aPlainOpenInvoiceKeepsItsOutstandingBadge() {
        val b = invoiceDetailBadgeFor(decode("""{"_id":"i1","status":"open","total":40.0,"amountDue":40.0,"dueDate":"2026-11-15"}"""), today)
        assertEquals("OUTSTANDING", b.label)
        assertEquals("due 2026-11-15", b.amountTrend)
        assertNull(b.partPaid)
        assertEquals("Amount due", invoiceAmountDueLabelFor(b))
        val overdue = invoiceDetailBadgeFor(decode("""{"_id":"i1","status":"open","amountDue":40.0,"dueDate":"2026-10-01"}"""), today)
        assertEquals("past due 2026-10-01", overdue.amountTrend)
    }
}
