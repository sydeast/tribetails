package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.decodeReleasedCount
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2087 / #2088 / #2195 on the desktop console: which quotes the office can
 * still change, and the words it uses, the same as admin web and Android.
 */
class InvoiceQuoteLifecycleTest {

    private fun inv(status: String, quoteDraft: Boolean? = null, archived: Boolean = false) =
        Invoice(_id = "i1", status = status, quoteDraft = quoteDraft, archivedAt = if (archived) JsonPrimitive("2026-11-12") else null)

    @Test
    fun aDraftCarryingTheQuoteMarkIsAQuoteSavedUnsent() {
        assertTrue(isQuoteDraft(inv("draft", quoteDraft = true)))
        assertFalse(isQuoteDraft(inv("draft")))
        assertFalse(isQuoteDraft(inv("quote", quoteDraft = true)))
    }

    @Test
    fun onlyAnUnacceptedUnarchivedQuoteCanBeTurnedOrWithdrawn() {
        assertTrue(quoteIsChangeable(inv("draft", quoteDraft = true)))
        assertTrue(quoteIsChangeable(inv("quote")))
        assertFalse(quoteIsChangeable(inv("quote", archived = true)))
        // An accepted quote is stamped open by the server.
        assertFalse(quoteIsChangeable(inv("open")))
        assertFalse(quoteIsChangeable(inv("draft")))
        assertFalse(quoteIsChangeable(inv("cancelled")))
        assertTrue(isArchivedQuote(inv("quote", archived = true)))
        assertFalse(isArchivedQuote(inv("open", archived = true)))
    }

    @Test
    fun theSendConfirmSaysAQuoteGoesOutAsAQuote() {
        assertEquals(SEND_QUOTE_CONFIRM_TEXT, sendConfirmBodyText(HouseholdSend.REVIEW_SEND, quote = true))
        assertTrue(sendConfirmBodyText(HouseholdSend.REVIEW_SEND).startsWith("This sends the draft"))
    }

    @Test
    fun theWithdrawNoticeCountsTheVisitsFromTheServersAnswer() {
        val released = decodeReleasedCount("""{"ok":true,"invoiceId":"q1","status":"cancelled","releasedSessionIds":["s1","s2"]}""")
        assertEquals(2, released)
        assertEquals(0, decodeReleasedCount("not json"))
        assertEquals(
            "Quote withdrawn. The household no longer sees it, and its 2 visits are back on the not yet invoiced list.",
            quoteWithdrawnText(released),
        )
        assertEquals("Quote sent. The household can accept or decline it now.", quoteSentMessage(false))
    }
}
