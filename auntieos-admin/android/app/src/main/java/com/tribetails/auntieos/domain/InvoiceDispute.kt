package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice

/** The two values the funds lane writes. Anything else is not a funds state. */
enum class InvoiceDisputeFundsState { WITHDRAWN, REINSTATED }

/**
 * The chargeback as this document actually carries it: two independent facts,
 * plus the one verdict every screen needs and none of them may re-derive.
 */
data class InvoiceDisputeInfo(
    /**
     * `disputeStatus` verbatim, or null when the doc holds none. Not normalized
     * and not translated: an unfamiliar status is shown as it was written, and a
     * label invented for it would be a guess about money.
     */
    val status: String?,
    /** Verified against the two the funds lane writes. Unrecognized reads as absent. */
    val fundsState: InvoiceDisputeFundsState?,
    /** The disputed amount, integer cents. Null is null; it is never a zero. */
    val amountCents: Long?,
    val disputeId: String?,
    /**
     * DOES THIS STILL WANT THE OPERATOR? The whole point of the type.
     *
     * `false` for exactly one status, `won`, and `true` for everything else
     * including a status this build has never heard of.
     *
     *  - False for `won` because nothing ever clears the flag. The contest
     *    happened and stays on record, so an invoice disputed once carries
     *    `disputeStatus` forever. A screen that alarmed on any non-empty value
     *    would show every previously-disputed invoice as permanently on fire,
     *    and an alarm that is always on is an alarm nobody reads.
     *  - True for everything else, including the unknown, because this is money
     *    that may have left the balance. `lost` is closed and still wants a
     *    human: where contested money ends up is the operator's call, never a
     *    webhook's. Downgrading a status we cannot interpret would be the one
     *    failure this whole lane exists to prevent — silence.
     *
     * A won dispute whose funds are still out stays false. Reinstatement lags
     * the ruling as a matter of course; the panel says so in words rather than
     * raising an alarm about an ordinary delay.
     */
    val open: Boolean,
)

/**
 * The chargeback flags, verified rather than trusted, or null when this invoice
 * has never been disputed.
 *
 * PRESENCE IS ANY OF THE THREE. The lifecycle lane
 * (`charge.dispute.created`/`closed`) writes `disputeStatus`; the funds lane
 * (`funds_withdrawn`/`funds_reinstated`) writes `disputeFundsState` and
 * deliberately writes no status, "because the balance moving says nothing about
 * where the contest stands". Stripe guarantees no ordering between the lanes, so
 * a withdrawal landing first leaves a document with moved money and no status —
 * the single most urgent shape there is, and one a status-only presence test
 * would render as no dispute at all.
 *
 * Mirrors the web `invoiceDispute` in `src/api/invoices.ts` decision for
 * decision, and is pinned against it by matching test cases on both sides.
 */
fun invoiceDisputeOrNull(invoice: Invoice): InvoiceDisputeInfo? {
    val status = invoice.disputeStatus?.trim()?.takeIf { it.isNotEmpty() }
    val fundsState = when (invoice.disputeFundsState?.trim()) {
        "withdrawn" -> InvoiceDisputeFundsState.WITHDRAWN
        "reinstated" -> InvoiceDisputeFundsState.REINSTATED
        else -> null
    }
    val disputeId = invoice.disputeId?.trim()?.takeIf { it.isNotEmpty() }

    if (status == null && fundsState == null && disputeId == null) return null

    return InvoiceDisputeInfo(
        status = status,
        fundsState = fundsState,
        // Absent stays absent. There is no "0 disputed".
        amountCents = invoice.disputeAmountCents,
        disputeId = disputeId,
        open = status != "won",
    )
}
