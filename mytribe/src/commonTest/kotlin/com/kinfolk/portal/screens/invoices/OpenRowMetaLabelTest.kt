package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.portal.Invoice
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.QuoteDecision
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * ISSUE #1039: a SECONDARY with billing access can accept or decline a quote
 * now (D-2026-09-28-BILLING-ACCESS-PAYS), so the invoice list's meta line
 * ("You declined this" / "You accepted this") can no longer assume the
 * signed-in viewer is always the one who answered.
 *
 * `quoteActorLabel` is the one function both the list row (here) and the
 * detail screen's sentence read, so the three cases are pinned once.
 */
class OpenRowMetaLabelTest {

    private fun quote(
        decision: QuoteDecision? = null,
        decidedByUid: String? = null,
        decidedByName: String? = null,
    ): Invoice = Invoice(
        id = "inv-1",
        kinfolkId = "kin-1",
        kinfolkName = null,
        client = null,
        total = 240.0,
        amountDue = 240.0,
        isPaid = false,
        status = InvoiceStatus.Quote,
        date = null,
        dueDate = "Aug 1, 2026",
        discount = null,
        terms = null,
        paymentsHistory = null,
        address = null,
        viewed = false,
        creditAmountCents = null,
        creditTarget = null,
        creditRedeemedAtMs = null,
        quoteDecision = decision,
        quoteDecidedByUid = decidedByUid,
        quoteDecidedByName = decidedByName,
        originalPaymentIntentId = null,
    )

    // ---- quoteActorLabel ----

    @Test
    fun quoteActorLabel_viewerIsTheActor_isYou() {
        val inv = quote(QuoteDecision.Accepted, decidedByUid = "u1", decidedByName = "Sam")
        assertEquals("You", quoteActorLabel(inv, viewerUid = "u1"))
    }

    @Test
    fun quoteActorLabel_someoneElseInTheHousehold_isTheirName() {
        val inv = quote(QuoteDecision.Accepted, decidedByUid = "u1", decidedByName = "Sam")
        assertEquals("Sam", quoteActorLabel(inv, viewerUid = "u2"))
    }

    @Test
    fun quoteActorLabel_noViewer_stillNamesTheActor() {
        // An unauthenticated read, or a screen that has not resolved the
        // viewer yet: still names whoever the doc says decided.
        val inv = quote(QuoteDecision.Accepted, decidedByUid = "u1", decidedByName = "Sam")
        assertEquals("Sam", quoteActorLabel(inv, viewerUid = null))
    }

    @Test
    fun quoteActorLabel_noStoredActor_isNull() {
        // No actor the viewer can match or name.
        val inv = quote(QuoteDecision.Accepted)
        assertNull(quoteActorLabel(inv, viewerUid = "u1"))
    }

    // ---- openRowMetaLabel ----

    @Test
    fun openRowMetaLabel_awaitingAnswer_needsYourAnswer() {
        assertEquals("Needs your answer", openRowMetaLabel(quote(), viewerUid = "u1"))
    }

    @Test
    fun openRowMetaLabel_viewerDeclinedIt_saysYou() {
        val inv = quote(QuoteDecision.Denied, decidedByUid = "u1")
        assertEquals("You declined this", openRowMetaLabel(inv, viewerUid = "u1"))
    }

    @Test
    fun openRowMetaLabel_householdMateDeclinedIt_namesThem() {
        val inv = quote(QuoteDecision.Denied, decidedByUid = "u2", decidedByName = "Sam")
        assertEquals("Sam declined this", openRowMetaLabel(inv, viewerUid = "u1"))
    }

    @Test
    fun openRowMetaLabel_declinedWithNoStoredActor_isNeutral() {
        val inv = quote(QuoteDecision.Denied)
        assertEquals("Declined", openRowMetaLabel(inv, viewerUid = "u1"))
    }

    @Test
    fun openRowMetaLabel_viewerAcceptedIt_saysYou() {
        // Defensive: an accepted quote normally leaves `InvoiceStatus.Quote`
        // entirely (the server re-stamps it `open`), but this branch exists
        // for a doc that still reads `quote` with an accepted decision on it.
        val inv = quote(QuoteDecision.Accepted, decidedByUid = "u1")
        assertEquals("You accepted this", openRowMetaLabel(inv, viewerUid = "u1"))
    }
}
