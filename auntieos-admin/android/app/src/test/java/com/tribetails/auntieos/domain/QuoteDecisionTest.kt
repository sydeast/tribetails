package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
/**
 * The household's answer to a quote as this app reads it (issue #385). The
 * field is written by the portal's `acceptQuote` / `denyQuote` callables and
 * only ever read here, so the whole contract is: recognize the two values the
 * server writes, and treat anything else as no answer at all.
 */
class QuoteDecisionTest {
    private fun inv(decision: String? = null, status: String = "quote") =
        Invoice(id = "i1", status = status, quoteDecision = decision)
    @Test
    fun `reads the two answers the server writes`() {
        assertEquals(QuoteDecision.ACCEPTED, invoiceQuoteDecision(inv("accepted")))
        assertEquals(QuoteDecision.DENIED, invoiceQuoteDecision(inv("denied")))
    }
    @Test
    fun `an absent field is no answer, not a default one`() {
        assertNull(invoiceQuoteDecision(inv(null)))
        assertNull(invoiceQuoteDecision(inv("")))
    }
    @Test
    fun `a value the server would never write reads as no answer`() {
        // Evidence something else wrote the field. Normalizing it into one of
        // the two would put a decision on the operator's screen that nobody made.
        assertNull(invoiceQuoteDecision(inv("maybe")))
        assertNull(invoiceQuoteDecision(inv("rejected")))
    }
    @Test
    fun `casing and padding still decode, matching invoiceStateOrNull's tolerance`() {
        assertEquals(QuoteDecision.DENIED, invoiceQuoteDecision(inv(" Denied ")))
    }
    @Test
    fun `a declined quote is still stamped a quote, which is the point of the field`() {
        val declined = inv("denied")
        assertEquals(InvoiceState.QUOTE, invoiceStateOrNull(declined))
        assertEquals(QuoteDecision.DENIED, invoiceQuoteDecision(declined))
    }
}
