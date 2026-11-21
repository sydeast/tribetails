package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * #2470: an invoice brought over from the old system part paid carries what
 * was paid before the move in `broughtOverPaidCents`, never a payment row and
 * never inside `paidCents`. The desktop console counts it as paid wherever it
 * reads "applied", as web and Android do. Decoded through the desktop REST
 * codec, the way the invoices stream reads them.
 */
class InvoiceBroughtOverPaidTest {

    private fun decode(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    @Test
    fun aFreshBroughtOverInvoiceReadsFifteenOfFortyPaid() {
        val inv = decode("""{"_id":"i1","status":"open","total":40.0,"amountDue":25.0,"broughtOverPaidCents":1500}""")
        assertEquals(1500L, invoiceBroughtOverCentsOf(inv))
        assertEquals(1500L, invoiceAppliedCentsOf(inv))
        assertEquals(InvoicePartPayment(paidCents = 1500L, remainingCents = 2500L), invoicePartPaidOf(inv))
    }

    @Test
    fun afterTenDollarsItReadsTwentyFiveOfFortyPaidAndFifteenOwed() {
        val inv = decode(
            """{"_id":"i1","status":"open","total":40.0,"amountDue":15.0,"paidCents":1000,"broughtOverPaidCents":1500}""",
        )
        assertEquals(2500L, invoiceAppliedCentsOf(inv))
        val part = invoicePartPaidOf(inv)!!
        assertEquals(InvoicePartPayment(paidCents = 2500L, remainingCents = 1500L), part)
        assertEquals("$25.00 of $40.00 paid", invoicePartPaidTrend(inv, part))
    }

    @Test
    fun anUnreadableBroughtOverFigureCountsForNothing() {
        for (raw in listOf("\"1500\"", "-5", "12.5", "null", "true")) {
            val inv = decode("""{"_id":"i1","status":"open","total":40.0,"amountDue":25.0,"broughtOverPaidCents":$raw}""")
            assertEquals(0L, invoiceBroughtOverCentsOf(inv), raw)
            assertNull(invoiceAppliedCentsOf(inv), raw)
        }
    }

    @Test
    fun aQuoteBroughtOverWithMoneyPaidCannotBeWithdrawn() {
        val quote = decode("""{"_id":"q1","status":"quote","total":40.0,"broughtOverPaidCents":1500}""")
        assertEquals(WITHDRAW_PAID_REASON, quoteWithdrawHeldReason(quote))
    }

    @Test
    fun theLineIsInPlainWords() {
        assertEquals("Paid in the old system", BROUGHT_OVER_LINE)
        assertFalse(BROUGHT_OVER_LINE.contains("—"))
    }
}
