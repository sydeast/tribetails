package com.tribetails.auntieos.domain
import com.tribetails.auntieos.data.model.Invoice
/** One Checkout Session Stripe would not expire, with Stripe's own plain reason. */
data class InvoiceCheckoutFailure(val sessionId: String, val reason: String)
/**
 * What the invoice detail says about the open Stripe payment links (#1113).
 * Mirrors the web `InvoiceCheckoutClosure` in `src/api/invoices.ts`.
 */
data class InvoiceCheckoutClosure(
    /** Open links the server expired after the invoice was paid. */
    val closedCount: Int,
    /** Links still open at Stripe. */
    val failed: List<InvoiceCheckoutFailure>,
)
private const val FALLBACK_REASON = "Stripe refused the request."
/**
 * The closure line's facts, or null when there is nothing to say: no sweep
 * record (the invoice had no open link) or one that expired nothing and failed
 * nothing. The map is whatever the document actually held, so each element is
 * checked rather than trusted.
 */
fun invoiceCheckoutClosureOrNull(invoice: Invoice): InvoiceCheckoutClosure? {
    val sweep = invoice.checkoutSweep as? Map<*, *> ?: return null
    val closed = (sweep["expiredIds"] as? List<*>)
        ?.count { it is String && it.isNotEmpty() } ?: 0
    // A failure for a session the server has since closed is stale: two passes
    // can run on one payment at once, and whichever records last wins `failed`.
    val closedNow = (invoice.closedCheckoutSessionIds as? List<*>).orEmpty().filterIsInstance<String>().toSet()
    val failed = (sweep["failed"] as? List<*>).orEmpty().mapNotNull { entry ->
        val row = entry as? Map<*, *> ?: return@mapNotNull null
        val id = (row["sessionId"] as? String)?.takeIf { it.isNotEmpty() && it !in closedNow } ?: return@mapNotNull null
        val reason = (row["reason"] as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: FALLBACK_REASON
        InvoiceCheckoutFailure(id, reason)
    }
    if (closed == 0 && failed.isEmpty()) return null
    return InvoiceCheckoutClosure(closed, failed)
}
/** The one line shown on the screen. Same words as the web panel. */
fun checkoutClosureLine(closure: InvoiceCheckoutClosure): String {
    if (closure.failed.isEmpty()) return "Open payment links closed (${closure.closedCount})"
    val what = if (closure.failed.size == 1) "an open payment link" else "${closure.failed.size} open payment links"
    return "Could not close $what: ${closure.failed.first().reason}"
}
