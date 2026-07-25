package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice

/**
 * The ONE invoice classifier both invoice surfaces read: the Den list
 * (ui/admin/InvoicesScreen.kt) and the detail screen (ui/invoices/
 * InvoiceDetailScreen.kt). Mirrors the web `src/lib/invoiceFormat.ts`
 * (`invoiceState` / `isInvoiceOverdue` / `invoiceActionsFor`) so all four
 * surfaces, two platforms, agree on what an invoice IS and what may be done
 * to it.
 *
 * Before this file the two Android screens classified independently and DID
 * disagree: the list used status/amountDue predicates, while the detail
 * screen's own `invoiceStatusFor` collapsed everything to PAID / OVERDUE /
 * OUTSTANDING with `amountDue <= 0 -> PAID` as its first line, which reads a
 * draft, a quote, and an unredeemed CREDIT (negative balance) as PAID.
 *
 * Every branch below is a POSITIVE read of the explicit status text or of a
 * real money field. Nothing here is "not X, so it must be Y", which is the
 * AO-12 defect the web module documents at length: the wasm admin defined
 * paid as `!draft && !outstanding`, so an unredeemed credit rendered a
 * confident PAID chip in production.
 *
 * DIVERGENCE FROM WEB, forced by the data model: the web enum also carries
 * `redeemed` (a credit the household has already drawn down), keyed off the
 * doc's `creditRedeemedAt` stamp. The Android [Invoice] model has no such
 * field, so a credit stays [InvoiceState.CREDIT] here. The action set is the
 * same for both on web (empty), so no gating decision depends on the split.
 */
enum class InvoiceState {
    QUOTE,
    DRAFT,
    CANCELLED,
    CREDIT,
    PAID,
    ZERO,
    OPEN,
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

/**
 * Classifies one invoice. Precedence matches the web `invoiceState` exactly:
 * an explicit status string wins, a negative balance is a credit even when
 * the label is missing, and only then do the money fields place an unlabeled
 * row.
 */
fun invoiceStateOf(invoice: Invoice): InvoiceState {
    val status = invoice.status.trim().lowercase()
    val amountDue = invoice.amountDue.finiteOrZero()
    val total = invoice.total.finiteOrZero()

    return when {
        status == "quote" -> InvoiceState.QUOTE
        status == "draft" -> InvoiceState.DRAFT
        status == "cancelled" -> InvoiceState.CANCELLED
        // A negative balance is the credit signal even when the label is
        // missing or stale (money is owed TO the household, not by them).
        status == "credit" || amountDue < 0.0 || total < 0.0 -> InvoiceState.CREDIT
        status == "paid" -> InvoiceState.PAID
        // Nothing explicit matched. Every branch from here reads a real number:
        amountDue > 0.0 -> InvoiceState.OPEN // a balance is genuinely owed
        total == 0.0 -> InvoiceState.ZERO // nothing was billed, not a paid claim
        else -> InvoiceState.PAID // amountDue <= 0 and total > 0: the balance is retired
    }
}

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
 * True only when the invoice is [InvoiceState.OPEN] AND its dueDate parses to
 * a date strictly before [todayIso]. Overdue is a display refinement of open,
 * never a state of its own: a draft, a quote, a credit, or a paid invoice is
 * never "overdue" no matter how stale its dueDate reads. Lexicographic
 * compare is correct on zero-padded YYYY-MM-DD.
 */
fun invoiceIsOverdue(invoice: Invoice, todayIso: String): Boolean {
    if (invoiceStateOf(invoice) != InvoiceState.OPEN) return false
    val due = invoiceIsoDatePrefixOrNull(invoice.dueDate) ?: return false
    return due < todayIso
}

/**
 * Which actions an invoice in [state] may be offered, on the list row and in
 * the detail screen alike.
 *
 * TOTAL and NON-OVERLAPPING by construction: the `when` is exhaustive over the
 * enum with no `else`, so adding an eighth state is a compile error here
 * rather than a silent fallthrough (the fallthrough is exactly how the list's
 * `else -> Receipt` row action offered a receipt on a cancelled invoice), and
 * the argument is the single enumerated state rather than a bag of booleans,
 * so an invoice cannot land in two buckets at once.
 *
 * The OVERDUE edge case, ruled explicitly: overdue is not a state (see
 * [invoiceIsOverdue]), so "overdue AND draft" and "overdue AND quote" are
 * unrepresentable rather than merely unhandled, and an overdue invoice gets
 * exactly the OPEN set. That is why this takes [state] alone.
 *
 * RECORD_PAYMENT is Android's spelling of the web's "Mark paid": the same
 * transition, through the Record-payment dialog that also writes the
 * Payment.invoiceId audit link.
 */
fun invoiceActionsFor(state: InvoiceState): List<InvoiceAction> = when (state) {
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
    // Nothing was ever billed, so nothing to collect and nothing to receipt.
    InvoiceState.ZERO -> emptyList()
}
/**
 * What has been collected against an invoice, and what is left, in integer
 * cents. Null when the invoice is not part-paid.
 *
 * PART-PAID IS A DISPLAY REFINEMENT OF [InvoiceState.OPEN], NOT AN EIGHTH
 * STATE, exactly like [invoiceIsOverdue] and for the same reason: it changes
 * the chip and the copy, and it never changes which actions the invoice may be
 * offered. A part-paid invoice is still an open invoice with a real balance, so
 * it keeps the whole outstanding action set, which is precisely what makes
 * collecting the rest possible. Making it a state would have forced
 * [invoiceActionsFor] to enumerate it, and the first person to write
 * `InvoiceState.PART_PAID -> emptyList()` would have reintroduced the very
 * defect this exists to remove.
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
    if (invoiceStateOf(invoice) != InvoiceState.OPEN) return null
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
