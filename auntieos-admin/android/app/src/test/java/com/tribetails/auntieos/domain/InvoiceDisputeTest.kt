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
        disputeEvidenceDueByMs: Long? = null,
        disputeReason: String? = null,
    ) = Invoice(
        id = "inv1",
        status = "paid",
        disputeStatus = disputeStatus,
        disputeFundsState = disputeFundsState,
        disputeAmountCents = disputeAmountCents,
        disputeId = disputeId,
        disputeEvidenceDueByMs = disputeEvidenceDueByMs,
        disputeReason = disputeReason,
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

    /**
     * THE ZERO TRAP, on the client side of the wire.
     *
     * `stripeDispute.ts#evidenceDueByMsOf` already refuses to store Stripe's
     * deliberate `due_by: 0` ("the customer's bank or credit card company
     * doesn't allow a response for this particular dispute", pinned SDK
     * Disputes.d.ts:210). This is the second lock, because a decoded [Invoice]
     * is whatever the document held: a 0 reaching this field must come out null
     * rather than become midnight on 1 January 1970 and a chargeback fifty-five
     * years overdue on a countdown whose only job is to be right about time.
     */
    @Test
    fun `a stored deadline of zero is no deadline, never the epoch`() {
        val d = invoiceDisputeOrNull(invoice(disputeStatus = "needs_response", disputeEvidenceDueByMs = 0L))!!
        assertNull(d.evidenceDueByMs)
    }

    @Test
    fun `an absent or negative deadline is no deadline`() {
        assertNull(invoiceDisputeOrNull(invoice(disputeStatus = "needs_response"))!!.evidenceDueByMs)
        assertNull(
            invoiceDisputeOrNull(
                invoice(disputeStatus = "needs_response", disputeEvidenceDueByMs = -1L),
            )!!.evidenceDueByMs,
        )
    }

    @Test
    fun `a real deadline travels through in epoch milliseconds, untouched`() {
        val ms = 1_787_000_000_000L
        assertEquals(
            ms,
            invoiceDisputeOrNull(
                invoice(disputeStatus = "needs_response", disputeEvidenceDueByMs = ms),
            )!!.evidenceDueByMs,
        )
    }

    /**
     * The reason is a raw snake_case Stripe token and it travels verbatim: the
     * SDK types `reason` as a plain `String` (Disputes.d.ts:89), not a union,
     * and Stripe adds categories on its own schedule.
     */
    @Test
    fun `the raw Stripe reason token travels through without normalizing`() {
        assertEquals(
            "product_not_received",
            invoiceDisputeOrNull(
                invoice(disputeStatus = "needs_response", disputeReason = "product_not_received"),
            )!!.reason,
        )
        assertEquals(
            "a_category_from_2027",
            invoiceDisputeOrNull(
                invoice(disputeStatus = "needs_response", disputeReason = "a_category_from_2027"),
            )!!.reason,
        )
    }

    @Test
    fun `a blank reason is no reason`() {
        assertNull(invoiceDisputeOrNull(invoice(disputeStatus = "needs_response", disputeReason = "  "))!!.reason)
    }

    /**
     * PRESENCE IS UNCHANGED. The reason and the deadline ride the same
     * lifecycle write as `disputeStatus`, so a document holding one of them and
     * none of status, funds state or dispute id is corrupt rather than
     * disputed, and admitting it would conjure a chargeback banner onto a clean
     * invoice.
     */
    @Test
    fun `a reason or a deadline alone is not a dispute`() {
        assertNull(invoiceDisputeOrNull(invoice(disputeReason = "fraudulent")))
        assertNull(invoiceDisputeOrNull(invoice(disputeEvidenceDueByMs = 1_787_000_000_000L)))
    }
}

/**
 * THE COUNTDOWN, and the three ways it must refuse to count.
 *
 * A chargeback nobody answers in time is lost by default, which is why the date
 * is on the screen at all, and which is also what makes it the most dangerous
 * thing on the screen to get wrong. Mirrors the web `invoiceDisputeDeadline`
 * cases in `src/api/invoices.test.ts` decision for decision.
 */
class InvoiceDisputeDeadlineTest {

    private val NOW = 1_786_000_000_000L
    private val DAY = 86_400_000L
    private val HOUR = 3_600_000L

    private fun dispute(status: String?, dueByMs: Long? = null) = invoiceDisputeOrNull(
        Invoice(
            id = "inv1",
            status = "paid",
            disputeId = "dp_1",
            disputeStatus = status,
            disputeEvidenceDueByMs = dueByMs,
        ),
    )!!

    @Test
    fun `an open deadline the operator can still meet counts down`() {
        val d = invoiceDisputeDeadline(dispute("needs_response", NOW + 3 * DAY), NOW)
        assertEquals(InvoiceDisputeDeadline.Due(NOW + 3 * DAY, 3 * DAY), d)
    }

    /**
     * A DEADLINE IN THE PAST IS ITS OWN STATE. Not a negative countdown and not
     * a verdict: `disputeStatus` is a webhook mirror of Stripe's and can still
     * read `needs_response` after Stripe has shut the window.
     */
    @Test
    fun `a deadline already gone is passed, never a negative countdown`() {
        assertEquals(
            InvoiceDisputeDeadline.Passed(NOW - 2 * DAY),
            invoiceDisputeDeadline(dispute("needs_response", NOW - 2 * DAY), NOW),
        )
    }

    @Test
    fun `the exact instant of the deadline reads as passed, not as zero left`() {
        assertEquals(
            InvoiceDisputeDeadline.Passed(NOW),
            invoiceDisputeDeadline(dispute("needs_response", NOW), NOW),
        )
    }

    /**
     * NULL IS NEITHER ZERO NOR AN ERROR. Stripe's `due_by: 0` means the issuing
     * bank allows no response at all; the webhook maps that and a genuinely
     * absent value both to null. Neither is a date, and the banner still shows.
     */
    @Test
    fun `a needed response with no stated deadline says so rather than inventing one`() {
        assertEquals(
            InvoiceDisputeDeadline.Unstated,
            invoiceDisputeDeadline(dispute("needs_response", null), NOW),
        )
    }

    /**
     * THE ONE THE OPERATOR ASKED FOR, at the pure-function level. Nothing ever
     * clears any of these fields, so a won dispute keeps its deadline forever;
     * counting down to it would send the operator to fight a settled contest.
     */
    @Test
    fun `a won dispute gets no countdown, deadline on the document or not`() {
        assertEquals(
            InvoiceDisputeDeadline.None,
            invoiceDisputeDeadline(dispute("won", NOW + 5 * DAY), NOW),
        )
    }

    @Test
    fun `a settled or in-review dispute that still wants a human gets no countdown`() {
        for (status in listOf("lost", "under_review", "prevented", "warning_closed")) {
            assertEquals(
                status,
                InvoiceDisputeDeadline.None,
                invoiceDisputeDeadline(dispute(status, NOW + 5 * DAY), NOW),
            )
        }
    }

    /**
     * The gate is an exact match on the one status Stripe defines as
     * answerable. `warning_needs_response` is the known candidate for widening
     * it and is deliberately left out: an inquiry is not a chargeback, and
     * adding it is an operator's ruling rather than this change's to make.
     */
    @Test
    fun `a status it cannot prove is answerable gets no countdown`() {
        assertEquals(
            InvoiceDisputeDeadline.None,
            invoiceDisputeDeadline(dispute("warning_needs_response", NOW + DAY), NOW),
        )
        assertEquals(
            InvoiceDisputeDeadline.None,
            invoiceDisputeDeadline(dispute("a_status_from_2027", NOW + DAY), NOW),
        )
    }

    /** The funds lane can land first, leaving moved money and no status to gate on. */
    @Test
    fun `no status at all means no countdown`() {
        assertEquals(InvoiceDisputeDeadline.None, invoiceDisputeDeadline(dispute(null), NOW))
    }

    /**
     * How long is left, in words. A DURATION and never a calendar computation:
     * the arithmetic is on elapsed milliseconds, so no timezone and no
     * daylight-saving boundary can move the answer, and it rounds toward the
     * operator having less time than they think.
     */
    @Test
    fun `time left counts whole days down, then hours, then gives up counting`() {
        assertEquals("6 days left", invoiceDisputeTimeLeft(6 * DAY))
        assertEquals("1 day left", invoiceDisputeTimeLeft(2 * DAY - 1))
        assertEquals("1 day left", invoiceDisputeTimeLeft(DAY))
        assertEquals("23 hours left", invoiceDisputeTimeLeft(DAY - 1))
        assertEquals("1 hour left", invoiceDisputeTimeLeft(HOUR))
        assertEquals("less than an hour left", invoiceDisputeTimeLeft(HOUR - 1))
        assertEquals("less than an hour left", invoiceDisputeTimeLeft(1))
    }

    /**
     * The deadline is formatted in the OPERATOR'S zone, which is why the
     * webhook stores epoch milliseconds and formats nothing. The zone is a
     * parameter here only so this case can pin one; the screen passes the
     * system default.
     */
    @Test
    fun `the deadline formats in the given zone, from milliseconds`() {
        // 2026-08-20T17:00:00Z.
        val ms = 1_787_245_200_000L
        val text = formatDisputeDeadline(ms, java.time.ZoneId.of("America/Chicago"))
        assertTrue(text, text.contains("2026"))
        assertTrue(text, text.contains("August 20"))
        assertFalse(text, text.contains("1970"))
    }

    /**
     * PLAIN ENGLISH WHERE WE HAVE IT, THE RAW TOKEN WHERE WE DO NOT. `reason`
     * is a plain `String` in the pinned SDK, and a token with no gloss renders
     * alone rather than as "Unknown", which would be this build's ignorance
     * dressed up as Stripe's answer.
     */
    @Test
    fun `every reason the pinned SDK docstring lists has a gloss`() {
        for (reason in listOf(
            "bank_cannot_process",
            "check_returned",
            "credit_not_processed",
            "customer_initiated",
            "debit_not_authorized",
            "duplicate",
            "fraudulent",
            "general",
            "incorrect_account_details",
            "insufficient_funds",
            "noncompliant",
            "product_not_received",
            "product_unacceptable",
            "subscription_canceled",
            "unrecognized",
        )) {
            assertTrue(reason, invoiceDisputeReasonGloss(reason) != null)
        }
    }

    @Test
    fun `a category Stripe has not shipped to this build has no gloss`() {
        assertNull(invoiceDisputeReasonGloss("a_category_from_2027"))
        assertNull(invoiceDisputeReasonGloss(""))
    }

    /**
     * The closed-history banner is pinned never to talk about responding, and
     * the reason renders on it too. This keeps the gloss table honest about
     * that rather than leaving a future category to break a screen test.
     */
    @Test
    fun `no gloss uses the vocabulary the closed-history banner is forbidden`() {
        val forbidden = Regex("respond|deadline|evidence", RegexOption.IGNORE_CASE)
        for (reason in listOf("fraudulent", "product_not_received", "general", "unrecognized")) {
            assertFalse(reason, forbidden.containsMatchIn(invoiceDisputeReasonGloss(reason)!!))
        }
    }
}
