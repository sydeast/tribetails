package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

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
     * The evidence deadline in epoch MILLISECONDS, or null for "no deadline is
     * stated". A stored 0 comes out null here too: Stripe sends that zero to
     * mean the issuing bank allows no response at all, not to mean 1 January
     * 1970.
     *
     * This is the raw fact. What the operator is shown about it is
     * [invoiceDisputeDeadline], which is where the urgency gate lives.
     */
    val evidenceDueByMs: Long?,
    /**
     * `disputeReason` verbatim, or null when the document holds none. Not
     * normalized and not translated, for the same reason [status] is not: it is
     * Stripe's vocabulary and it grows without asking.
     */
    val reason: String?,
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

    // PRESENCE IS STILL THESE THREE AND ONLY THESE THREE. The reason and the
    // deadline ride the same lifecycle write as `disputeStatus`, so a document
    // holding one of them and none of the three below is corrupt rather than
    // disputed, and admitting it here would conjure a chargeback banner onto a
    // clean invoice.
    if (status == null && fundsState == null && disputeId == null) return null

    return InvoiceDisputeInfo(
        status = status,
        fundsState = fundsState,
        // Absent stays absent. There is no "0 disputed".
        amountCents = invoice.disputeAmountCents,
        disputeId = disputeId,
        // THE SECOND LOCK ON STRIPE'S ZERO. `stripeDispute.ts` already refuses
        // to store a `due_by` of 0, because Stripe sends it to mean the issuing
        // bank allows no response at all rather than to mean the epoch. This
        // repeats the refusal on the read side, because a decoded Invoice is
        // whatever the document actually held.
        evidenceDueByMs = invoice.disputeEvidenceDueByMs?.takeIf { it > 0L },
        reason = invoice.disputeReason?.trim()?.takeIf { it.isNotEmpty() },
        open = status != "won",
    )
}

/**
 * THE ONE STATUS THAT MAKES A DEADLINE ACTIONABLE.
 *
 * Stripe's `Dispute.status` docstring (pinned SDK, Disputes.d.ts:93) lists
 * `warning_needs_response`, `warning_under_review`, `warning_closed`,
 * `needs_response`, `under_review`, `won`, `lost` and `prevented`. Exactly one
 * of them is a chargeback awaiting the operator's answer, and the countdown is
 * gated on an exact match against it.
 *
 * Everything else keeps whatever alarm [InvoiceDisputeInfo.open] gave it and
 * gets no countdown:
 *
 *  - `won` and `lost` are settled and still carry their deadline, because
 *    nothing ever clears any of these fields. Counting down to it would send
 *    the operator to fight a contest that is already over.
 *  - `under_review` means the evidence is already in. There is nothing left to
 *    submit by the date.
 *  - a status this build has never heard of gets no countdown for the same
 *    reason it gets no relabelling: we cannot prove it is answerable.
 *
 * `warning_needs_response` is the known candidate for widening this and is
 * deliberately not here. It is an inquiry rather than a chargeback, it can
 * carry its own `due_by`, and whether an inquiry deserves the same red clock is
 * an operator's ruling rather than this file's guess.
 */
private const val ANSWERABLE_DISPUTE_STATUS = "needs_response"

/**
 * What the operator is told about the response deadline.
 *
 * Four states, because there are genuinely four things to say and three of them
 * are refusals. Mirrors the web `InvoiceDisputeDeadline` in
 * `src/api/invoices.ts` case for case.
 */
sealed interface InvoiceDisputeDeadline {
    /** An answerable dispute with a deadline still ahead. The one earned clock. */
    data class Due(val dueByMs: Long, val msRemaining: Long) : InvoiceDisputeDeadline
    /** An answerable dispute whose deadline is behind us. Not a verdict. */
    data class Passed(val dueByMs: Long) : InvoiceDisputeDeadline
    /** An answerable dispute with no deadline on the document at all. */
    data object Unstated : InvoiceDisputeDeadline
    /** Nothing to count down to, because the dispute is not answerable. */
    data object None : InvoiceDisputeDeadline
}

/**
 * The deadline as the screen must present it, from the document and the clock.
 *
 * Pure, and `nowMs` is a parameter rather than a `System.currentTimeMillis()`
 * inside, for the same reason `invoiceDisputeTone` in InvoiceDetailScreen.kt is
 * a function rather than an inline `if`: the branch that decides whether an
 * operator sees a red clock is the branch a test has to be able to call.
 *
 * A DEADLINE THAT HAS PASSED IS ITS OWN STATE. `disputeStatus` is a webhook
 * mirror of Stripe's, so it can still read `needs_response` after Stripe has
 * shut the window — the `charge.dispute.closed` event may not have landed, or
 * may never land if the dispute was answered elsewhere. So the past-deadline
 * case says the window closed and points at Stripe; it does not claim the
 * dispute is lost. Rendering `-2 days left` would be the arithmetic being
 * correct and the sentence being nonsense.
 *
 * The exact instant counts as passed. At `dueByMs` there is no time left to
 * submit anything, and "0 days left" reads as a day.
 */
fun invoiceDisputeDeadline(dispute: InvoiceDisputeInfo, nowMs: Long): InvoiceDisputeDeadline {
    if (dispute.status != ANSWERABLE_DISPUTE_STATUS) return InvoiceDisputeDeadline.None
    val dueByMs = dispute.evidenceDueByMs ?: return InvoiceDisputeDeadline.Unstated
    if (dueByMs <= nowMs) return InvoiceDisputeDeadline.Passed(dueByMs)
    return InvoiceDisputeDeadline.Due(dueByMs, dueByMs - nowMs)
}

/**
 * How much time is left, in words.
 *
 * A DURATION, never a calendar computation. The arithmetic runs on elapsed
 * milliseconds, so no timezone and no daylight-saving boundary can move the
 * answer — which matters because the absolute date beside it IS rendered in the
 * operator's zone, and the two must not be able to disagree.
 *
 * Rounds down at every step, toward the operator having less time than they
 * think. Stops at "less than an hour" rather than counting minutes: a minute
 * counter would be stale the moment it painted, since nothing here ticks.
 */
fun invoiceDisputeTimeLeft(msRemaining: Long): String {
    val hours = msRemaining / 3_600_000L
    if (hours < 1L) return "less than an hour left"
    val days = hours / 24L
    if (days < 1L) return "$hours ${if (hours == 1L) "hour" else "hours"} left"
    return "$days ${if (days == 1L) "day" else "days"} left"
}

/**
 * The deadline as a date the operator can read, in THEIR timezone.
 *
 * The webhook stores epoch milliseconds and formats nothing, "because a date
 * rendered in the backend is a date rendered in the SERVER'S locale and
 * timezone, and the operator reading it is not there" (stripeDispute.ts). The
 * zone name is printed because a deadline whose zone is ambiguous is a deadline
 * with a several-hour error bar on it.
 *
 * `zone` is a parameter only so a test can pin one. The screen passes the
 * system default and must keep doing so.
 */
fun formatDisputeDeadline(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    Instant.ofEpochMilli(ms)
        .atZone(zone)
        .format(DateTimeFormatter.ofPattern("MMMM d, yyyy 'at' h:mm a zzz", Locale.US))

/**
 * Plain English for a Stripe dispute reason, or null when this build has never
 * seen the token.
 *
 * THE TOKEN IS ALWAYS SHOWN; THIS IS A COURTESY ON TOP OF IT. `reason` is a
 * plain `String` in the pinned SDK (Disputes.d.ts:89), not a union, and the
 * docstring's list is prose that Stripe extends on its own schedule. Returning
 * null rather than "Unknown" is the difference between the screen saying
 * nothing about a category it does not know and the screen presenting this
 * build's ignorance as Stripe's answer.
 *
 * The wording carries a constraint from `InvoiceDetailDisputeTest`: the reason
 * renders on the closed-history banner too, and that banner is pinned never to
 * talk about responding. Nothing here may use "respond", "deadline" or
 * "evidence", and a case in `InvoiceDisputeTest` holds the table to it.
 *
 * Kept identical to the web `invoiceDisputeReasonGloss` in `src/api/invoices.ts`.
 */
private val DISPUTE_REASON_GLOSS: Map<String, String> = mapOf(
    "bank_cannot_process" to "their bank could not process the payment",
    "check_returned" to "the check was returned unpaid",
    "credit_not_processed" to "they say a refund they were promised never arrived",
    "customer_initiated" to "the cardholder asked their bank to reverse it",
    "debit_not_authorized" to "they say they never authorized the debit",
    "duplicate" to "they say they were charged twice for the same thing",
    "fraudulent" to "they say they did not authorize this charge at all",
    "general" to "the bank filed it without naming a category",
    "incorrect_account_details" to "the account details on the charge were wrong",
    "insufficient_funds" to "the account did not have the funds",
    "noncompliant" to "the charge broke a card network rule",
    "product_not_received" to "they say the care was never delivered",
    "product_unacceptable" to "they say the care was not what was agreed",
    "subscription_canceled" to "they say the arrangement had already been canceled",
    "unrecognized" to "they do not recognize the charge on their statement",
)

fun invoiceDisputeReasonGloss(reason: String): String? = DISPUTE_REASON_GLOSS[reason]
