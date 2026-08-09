package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-logic tests for the chargeback flags, mirroring the web
 * `invoiceDispute` cases in `src/api/invoices.test.ts` so both staff clients
 * are pinned to the same reading of the same two fields.
 *
 * The fields come from `functions/src/billing/stripeDispute.ts`, which writes
 * them in two independent lanes: the lifecycle lane
 * (`charge.dispute.created`/`closed`) writes `disputeStatus`, and the funds lane
 * (`funds_withdrawn`/`funds_reinstated`) writes `disputeFundsState` and
 * deliberately writes no status, because the balance moving says nothing about
 * where the contest stands.
 */
class InvoiceDisputeTest {

    private fun invoice(
        disputeStatus: String? = null,
        disputeFundsState: String? = null,
        disputeAmountCents: Long? = null,
        disputeId: String? = null,
    ) = Invoice(
        id = "inv1",
        status = "paid",
        disputeStatus = disputeStatus,
        disputeFundsState = disputeFundsState,
        disputeAmountCents = disputeAmountCents,
        disputeId = disputeId,
    )

    @Test
    fun `an invoice that was never disputed has no dispute`() {
        assertNull(invoiceDisputeOrNull(invoice()))
    }

    @Test
    fun `an open chargeback is open and keeps the raw Stripe status`() {
        val d = invoiceDisputeOrNull(invoice(disputeStatus = "needs_response", disputeAmountCents = 4000L))!!
        assertTrue(d.open)
        assertEquals("needs_response", d.status)
        assertEquals(4000L, d.amountCents)
    }

    /**
     * THE OPERATOR RULE. Nothing ever clears `disputeStatus` — the contest did
     * happen — so a won invoice carries the flag for good. It is history, and
     * both screens key their alarm off this one boolean.
     */
    @Test
    fun `won reads as closed history, not as an open problem`() {
        assertFalse(invoiceDisputeOrNull(invoice(disputeStatus = "won", disputeId = "dp_1"))!!.open)
    }

    @Test
    fun `lost and under_review both still want the operator`() {
        assertTrue(invoiceDisputeOrNull(invoice(disputeStatus = "lost"))!!.open)
        assertTrue(invoiceDisputeOrNull(invoice(disputeStatus = "under_review"))!!.open)
    }

    /**
     * Fail loud, never guess. `won` is the only value proven to be a closed and
     * good outcome; a status this build has not heard of is shown raw and left
     * wanting attention rather than quietly downgraded.
     */
    @Test
    fun `an unrecognized status stays open and stays readable`() {
        val d = invoiceDisputeOrNull(invoice(disputeStatus = "warning_needs_response"))!!
        assertTrue(d.open)
        assertEquals("warning_needs_response", d.status)
    }

    /** The lanes have no ordering guarantee, so this doc shape is real. */
    @Test
    fun `funds that moved before any status arrived are still a dispute`() {
        val d = invoiceDisputeOrNull(invoice(disputeFundsState = "withdrawn", disputeId = "dp_1"))!!
        assertNull(d.status)
        assertEquals(InvoiceDisputeFundsState.WITHDRAWN, d.fundsState)
        assertTrue(d.open)
    }

    @Test
    fun `a dispute known only by its id still shows`() {
        assertTrue(invoiceDisputeOrNull(invoice(disputeId = "dp_1"))!!.open)
    }

    @Test
    fun `a won dispute stays closed while the funds are still out`() {
        val d = invoiceDisputeOrNull(invoice(disputeStatus = "won", disputeFundsState = "withdrawn"))!!
        assertFalse(d.open)
        assertEquals(InvoiceDisputeFundsState.WITHDRAWN, d.fundsState)
    }

    /** An unrecognized funds state is not a funds state. Absent, never invented. */
    @Test
    fun `a funds state outside the two the webhook writes is dropped`() {
        val d = invoiceDisputeOrNull(invoice(disputeStatus = "lost", disputeFundsState = "pending"))!!
        assertNull(d.fundsState)
    }

    /**
     * Money rule: an absent disputed amount is null, never 0. A zero would claim
     * the bank pulled nothing back.
     */
    @Test
    fun `an absent disputed amount is null, never zero`() {
        assertNull(invoiceDisputeOrNull(invoice(disputeStatus = "lost"))!!.amountCents)
    }

    @Test
    fun `a blank status is not a dispute`() {
        assertNull(invoiceDisputeOrNull(invoice(disputeStatus = "")))
        assertNull(invoiceDisputeOrNull(invoice(disputeStatus = "   ")))
    }
}
