package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2358 (operator ruling 2026-11-20): an invoice with any applied payment is
 * never cancelled. On the desktop console, Withdraw quote is held and says why
 * when the quote has a payment recorded on it. Decoded through the desktop
 * REST codec, the way the invoices stream reads them.
 */
class QuoteWithdrawHeldTest {

    private fun decode(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    @Test
    fun aQuoteWithNoPaymentCanBeWithdrawn() {
        val quote = decode("""{"_id":"q1","status":"quote","total":40.0}""")
        assertTrue(quoteIsChangeable(quote))
        assertNull(quoteWithdrawHeldReason(quote))
        assertNull(quoteWithdrawHeldReason(decode("""{"_id":"q1","status":"quote","total":40.0,"paidCents":0}""")))
    }

    @Test
    fun aQuoteWithAPaymentRecordedOnItIsHeldWithTheServersSentence() {
        val quote = decode("""{"_id":"q1","status":"quote","total":40.0,"paidCents":1500}""")
        assertEquals(WITHDRAW_PAID_REASON, quoteWithdrawHeldReason(quote))
        val unsent = decode("""{"_id":"q1","status":"draft","quoteDraft":true,"total":40.0,"paidCents":1}""")
        assertEquals(WITHDRAW_PAID_REASON, quoteWithdrawHeldReason(unsent))
    }

    @Test
    fun anUnreadablePaidFigureIsNoPayment() {
        assertNull(quoteWithdrawHeldReason(decode("""{"_id":"q1","status":"quote","total":40.0,"paidCents":"15"}""")))
        assertNull(quoteWithdrawHeldReason(decode("""{"_id":"q1","status":"quote","total":40.0,"paidCents":null}""")))
    }

    @Test
    fun theSentenceIsTheSameOnEveryClient() {
        assertEquals("A payment is recorded on this quote, so it cannot be withdrawn.", WITHDRAW_PAID_REASON)
        assertFalse(WITHDRAW_PAID_REASON.contains("—"))
    }
}
