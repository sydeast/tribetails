package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice

/**
 * The ONE invoice state module both invoice surfaces read: the Den list
 * (ui/admin/InvoicesScreen.kt) and the detail screen (ui/invoices/
 * InvoiceDetailScreen.kt).
 *
 * THIS FILE NO LONGER CLASSIFIES. Under ADR-0002 the server's Invoice State
 * Classifier (`mytribe/functions/src/lib/invoiceEditPolicy.ts`) is the single
 * authority on what an invoice IS: every money-touching callable persists its
 * output onto the doc as two fields, `status` (one of the eight canonical
 * lowercase states in `INVOICE_STATES`) and `editScope`, and a backfill
 * stamped every pre-existing doc. What lives here now is the READ side:
 * decoding the stored stamp into typed values and mapping those values to the
 * affordances a screen may offer.
 *
 * The classifier this file used to hold (`invoiceStateOf`, precedence over
 * status text and money fields) is deleted, not moved. It was one of five
 * copies of the same rule at three different state cardinalities, and its
 * seven states lacked `redeemed` entirely: a credit the household had already
 * drawn down could not be rendered as such on Android at all. Consuming the
 * stored stamp closes that drift for good, because a state the server adds
 * arrives here as data instead of waiting for a ported branch.
 *
 * ABSENT OR UNRECOGNIZED STAMPS ARE NOT RE-DERIVED, deliberately. Re-deriving
 * "just for the fallback" would quietly resurrect the fifth classifier and the
 * AO-12 negation defect with it. Instead the failure is soft and visible:
 * [invoiceStateOrNull] returns null, the screens render the RAW stored string
 * where the state chip would be, [invoiceActionsFor] offers no actions, and
 * [invoiceEditScopeOf] offers no edit affordances. A doc that reaches the app
 * unstamped renders as exactly what it is - a doc this app does not claim to
 * understand - rather than as a guess.
 */

/**
 * The eight canonical invoice states, mirroring the server's `INVOICE_STATES`
 * one for one (order and all). `REDEEMED` is the state the deleted 7-state
 * classifier could never produce.
 */
enum class InvoiceState {
    QUOTE,
    DRAFT,
    CANCELLED,
    CREDIT,
    REDEEMED,
    PAID,
    ZERO,
    OPEN,
}

/**
 * Decodes the stored state stamp, or null when the doc carries no
 * recognizable stamp.
 *
 * A DECODE, NOT A CLASSIFICATION: the only field read is `status`, and the
 * only tolerance applied is the repo's lowercase-before-compare convention
 * (the server always writes lowercase; trimming and lowercasing here means a
 * legacy hand-written `"Draft"` still decodes rather than falling to null).
 * No money field is consulted, ever - the server already did that, in the
 * same write that moved the money.
 *
 * Null is an honest answer, not an error: it means "this doc predates the
 * stamp or carries a vocabulary this build does not know", and every consumer
 * fails soft on it (raw string rendered, no actions, no edit affordances).
 */
fun invoiceStateOrNull(invoice: Invoice): InvoiceState? = when (invoice.status.trim().lowercase()) {
    "quote" -> InvoiceState.QUOTE
    "draft" -> InvoiceState.DRAFT
    "cancelled" -> InvoiceState.CANCELLED
    "credit" -> InvoiceState.CREDIT
    "redeemed" -> InvoiceState.REDEEMED
    "paid" -> InvoiceState.PAID
    "zero" -> InvoiceState.ZERO
    "open" -> InvoiceState.OPEN
    else -> null
}

/**
 * The stored edit-scope stamp: how much of this invoice the server will let
 * an edit change. Mirrors the server's `InvoiceEditScope`
 * (`'all' | 'metadataOnly' | 'none'`).
 */
enum class InvoiceEditScope {
    ALL,
    METADATA_ONLY,
    NONE,
}

/**
 * Decodes the stored `editScope` stamp. Same decode-only contract as
 * [invoiceStateOrNull], same case tolerance.
 *
 * ABSENT OR UNRECOGNIZED READS AS [InvoiceEditScope.NONE]: no edit
 * affordances are offered for a doc whose editability the server has not
 * stated. That is the deliberate fail-soft ruling, not a shortcut - the
 * alternative (recomputing the policy from the money) is precisely the
 * client-side re-derivation ADR-0002 retires, and offering `ALL` on a shrug
 * would invite an edit the server will refuse anyway.
 *
 * NO ANDROID SURFACE CONSUMES THIS YET, a fact about the app rather than an
 * omission here: the admin's only invoice-field editor (`updateInvoice`) was
 * deleted as dead code in the W2-2 re-point, and the linked-sessions editor
 * is deliberately NOT gated on editScope, mirroring the server's own ruling
 * in `admin/linkInvoiceSessions.ts` (attributing which sessions a bill
 * covers is not an edit of what the household was asked for). This decode
 * pins the contract the first real edit surface will read.
 */
fun invoiceEditScopeOf(invoice: Invoice): InvoiceEditScope = when (invoice.editScope?.trim()?.lowercase()) {
    "all" -> InvoiceEditScope.ALL
    "metadataonly" -> InvoiceEditScope.METADATA_ONLY
    else -> InvoiceEditScope.NONE
}

/** Consequential actions an invoice surface may offer. */
enum class InvoiceAction {
    SEND_REMINDER,
    RECORD_PAYMENT,
    GENERATE_RECEIPT,
    REVIEW_AND_SEND,
}

/** NaN/Infinity read as "no evidence", never as a false 0 that could tip a comparison. */
private fun Double.finiteOrZero(): Double = if (isFinite()) this else 0.0

/** A YYYY-MM-DD prefix, or null when the field cannot be read as one. */
internal fun invoiceIsoDatePrefixOrNull(raw: String): String? {
    val s = raw.trim()
    if (s.length < 10) return null
    val candidate = s.take(10)
    if (candidate[4] != '-' || candidate[7] != '-') return null
    for (i in candidate.indices) {
        if (i == 4 || i == 7) continue
        if (!candidate[i].isDigit()) return null
    }
    return candidate
}

/**
 * True only when the stored stamp reads [InvoiceState.OPEN] AND dueDate parses
 * to a date strictly before [todayIso]. Overdue stays a CLIENT-side display
 * refinement of open because it is a function of the clock, which a persisted
 * stamp cannot carry: the server cannot rewrite every invoice at midnight.
 * A draft, a quote, a credit, a redeemed credit, a paid invoice, and an
 * UNSTAMPED doc are never "overdue" no matter how stale their dueDate reads.
 * Lexicographic compare is correct on zero-padded YYYY-MM-DD.
 */
fun invoiceIsOverdue(invoice: Invoice, todayIso: String): Boolean {
    if (invoiceStateOrNull(invoice) != InvoiceState.OPEN) return false
    val due = invoiceIsoDatePrefixOrNull(invoice.dueDate) ?: return false
    return due < todayIso
}

/**
 * Which actions an invoice whose stored stamp reads [state] may be offered, on
 * the list row and in the detail screen alike.
 *
 * TOTAL AND NON-OVERLAPPING by construction: the `when` is exhaustive over the
 * enum plus null with no `else`, so a ninth server state (arriving here as a
 * new enum entry) is a compile error rather than a silent fallthrough, and the
 * argument is the single decoded state rather than a bag of booleans, so an
 * invoice cannot land in two buckets at once.
 *
 * NULL - an unstamped or unrecognized doc - OFFERS NOTHING. Fabricating an
 * affordance for a doc the app does not understand is how a cancelled invoice
 * once offered a Receipt button; the row stays tappable through to the detail
 * screen, where the raw status renders.
 *
 * The OVERDUE edge case, ruled explicitly: overdue is not a state (see
 * [invoiceIsOverdue]), so an overdue invoice gets exactly the OPEN set.
 *
 * RECORD_PAYMENT is Android's spelling of the web's "Mark paid": the same
 * transition, through the Record-payment dialog that also writes the
 * Payment.invoiceId audit link.
 */
fun invoiceActionsFor(state: InvoiceState?): List<InvoiceAction> = when (state) {
    // A real, unpaid balance: collect it.
    InvoiceState.OPEN -> listOf(InvoiceAction.SEND_REMINDER, InvoiceAction.RECORD_PAYMENT)
    // Settled. A receipt is all that is left; re-collecting is the reported bug
    // (a paid invoice still offering "Mark paid", which the server rejects, and
    // "Send reminder", which would nag a household that already paid).
    InvoiceState.PAID -> listOf(InvoiceAction.GENERATE_RECEIPT)
    // Not sent yet, so nothing to remind about and nothing to collect.
    InvoiceState.DRAFT -> listOf(InvoiceAction.REVIEW_AND_SEND)
    // A quote is not a bill; it gains payment actions only once converted.
    InvoiceState.QUOTE -> emptyList()
    // Withdrawn: acting on it would contradict the withdrawal.
    InvoiceState.CANCELLED -> emptyList()
    // Money owed TO the household; redemption is its own flow.
    InvoiceState.CREDIT -> emptyList()
    // Already drawn down. Nothing left to collect, remind about, or receipt.
    // The deleted classifier had no such state, so before the stamp a redeemed
    // credit on Android fell wherever its money fields happened to point.
    InvoiceState.REDEEMED -> emptyList()
    // Nothing was ever billed, so nothing to collect and nothing to receipt.
    InvoiceState.ZERO -> emptyList()
    // No recognizable stamp: no affordance is fabricated for a doc this app
    // does not claim to understand.
    null -> emptyList()
}
/**
 * What has been collected against an invoice, and what is left, in integer
 * cents. Null when the invoice is not part-paid.
 *
 * PART-PAID IS A DISPLAY REFINEMENT OF [InvoiceState.OPEN], NOT A NINTH
 * STATE, exactly like [invoiceIsOverdue] and for the same reason: it changes
 * the chip and the copy, and it never changes which actions the invoice may be
 * offered. A part-paid invoice is still an open invoice with a real balance, so
 * it keeps the whole outstanding action set, which is precisely what makes
 * collecting the rest possible.
 *
 * READS [Invoice.paidCents], NEVER `total - amountDue`. Those are float dollars,
 * and on every invoice the pre-2026-07-25 write touched `amountDue` reads 0.0
 * while a real balance is owed, so the subtraction reports the whole total as
 * collected on exactly the rows that are wrong. An invoice with no `paidCents`
 * is not claimed to be part-paid, because there is no record that it is.
 *
 * Mirrors the web `src/lib/invoiceFormat.ts#invoicePartialPayment` so the two
 * admin surfaces cannot disagree about what an invoice is.
 */
data class InvoicePartPayment(
    val paidCents: Long,
    val remainingCents: Long,
)
fun invoicePartPaid(invoice: Invoice): InvoicePartPayment? {
    if (invoiceStateOrNull(invoice) != InvoiceState.OPEN) return null
    if (invoice.paidCents <= 0L) return null
    val amountDue = invoice.amountDue.finiteOrZero()
    val remainingCents = Math.round(amountDue * 100.0)
    if (remainingCents <= 0L) return null
    return InvoicePartPayment(paidCents = invoice.paidCents, remainingCents = remainingCents)
}
/** "$20.00" from an integer count of cents. */
fun formatCentsUsd(cents: Long): String {
    val sign = if (cents < 0) "-" else ""
    val abs = kotlin.math.abs(cents)
    return "$sign$${abs / 100}.${(abs % 100).toString().padStart(2, '0')}"
}
