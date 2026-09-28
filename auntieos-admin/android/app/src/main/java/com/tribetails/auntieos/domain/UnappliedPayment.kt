package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultOpenInvoice
import com.tribetails.auntieos.data.contracts.ListUnappliedPaymentsResultPayment
import com.tribetails.auntieos.data.contracts.ResolveUnappliedPaymentResult
import java.time.ZoneId

/**
 * #1003: the pure half of "Payments needing a decision" on the household
 * profile. A card payment the webhook recorded but could not apply to its
 * invoice waits here until the owner decides what it becomes: account credit,
 * an amount applied to one open invoice, and whatever is left kept on the
 * payment. There are no refunds. Every string is shared word for word with the
 * web admin and the desktop console.
 */

/** "INV-1042", or "" when the server had no number for it. */
private fun invoiceLabel(number: String): String = number.trim()

/** "$25.00 card payment on invoice INV-1042". */
fun unappliedPaymentHeadline(p: ListUnappliedPaymentsResultPayment): String {
    val inv = invoiceLabel(p.invoiceNumber)
    val head = "${formatCentsUsd(p.amountCents)} card payment"
    return if (inv.isEmpty()) head else "$head on invoice $inv"
}

/** "Sep 27, 2026. Not applied because the invoice was already marked paid." */
fun unappliedPaymentDetail(p: ListUnappliedPaymentsResultPayment, zone: ZoneId = ZoneId.systemDefault()): String {
    val reason = p.reason.trim().trimEnd('.')
    return "${creditDate(p.receivedAtMs, zone)}. Not applied because $reason."
}

/** The dialog's lead line. */
fun decidePaymentLead(p: ListUnappliedPaymentsResultPayment): String {
    val inv = invoiceLabel(p.invoiceNumber)
    val on = if (inv.isEmpty()) "" else " on invoice $inv"
    return "Card payment of ${formatCentsUsd(p.amountCents)}$on. There are no refunds. " +
        "Anything you do not credit or apply stays recorded on the payment."
}

/** A picker row: "INV-1050, $40.00 due". */
fun openInvoiceOptionLabel(inv: ListUnappliedPaymentsResultOpenInvoice): String =
    "${inv.invoiceNumber.ifBlank { inv.invoiceId }}, ${formatCentsUsd(inv.amountDueCents)} due"

const val DECIDE_NONE_OPTION = "None"
const val NO_OPEN_INVOICES_TEXT = "No open invoices for this household."

sealed interface DecideForm {
    /**
     * What will be sent. Already normalised the way the server wants it: the
     * reason is "" when no credit is given, the invoice id "" when nothing is
     * applied.
     */
    data class Ready(
        val creditCents: Long,
        val creditReason: String,
        val applyInvoiceId: String,
        val applyCents: Long,
        val keepCents: Long,
    ) : DecideForm

    data class Invalid(val message: String) : DecideForm
}

const val DECIDE_BAD_AMOUNT = "Enter an amount in dollars, like 12.50."
const val DECIDE_OVER_PAYMENT = "The credit and the applied amount add up to more than this payment."
const val DECIDE_NEED_REASON = "Enter a reason for the credit."
const val DECIDE_NEED_INVOICE = "Choose an invoice for the applied amount."

fun decideInvoiceOwesOnly(amountDueCents: Long): String = "That invoice owes only ${formatCentsUsd(amountDueCents)}."

/** A blank field is zero; anything else must be a plain dollar amount. Null when it is not. */
private fun optionalCents(text: String): Long? = if (text.isBlank()) 0L else parseDollarsToCents(text)

/**
 * Reads the dialog's four inputs into a request, or the first refusal. Called
 * on every keystroke: the refusal shows inline and Save stays disabled until it
 * clears, so nothing the server would refuse on these grounds is ever sent.
 */
fun parseDecideForm(
    paymentCents: Long,
    openInvoices: List<ListUnappliedPaymentsResultOpenInvoice>,
    creditText: String,
    reasonText: String,
    applyInvoiceId: String,
    applyText: String,
): DecideForm {
    val credit = optionalCents(creditText) ?: return DecideForm.Invalid(DECIDE_BAD_AMOUNT)
    val invoice = openInvoices.firstOrNull { it.invoiceId == applyInvoiceId && applyInvoiceId.isNotBlank() }
    // The apply field is disabled with no invoice chosen, but it may still hold
    // what was typed before the picker went back to None.
    val apply = optionalCents(applyText) ?: return DecideForm.Invalid(DECIDE_BAD_AMOUNT)
    if (apply > 0L && invoice == null) return DecideForm.Invalid(DECIDE_NEED_INVOICE)
    val reason = reasonText.trim()
    if (credit > 0L && reason.isEmpty()) return DecideForm.Invalid(DECIDE_NEED_REASON)
    if (credit + apply > paymentCents) return DecideForm.Invalid(DECIDE_OVER_PAYMENT)
    if (invoice != null && apply > invoice.amountDueCents) {
        return DecideForm.Invalid(decideInvoiceOwesOnly(invoice.amountDueCents))
    }
    return DecideForm.Ready(
        creditCents = credit,
        creditReason = if (credit > 0L) reason else "",
        applyInvoiceId = if (apply > 0L) invoice!!.invoiceId else "",
        applyCents = apply,
        keepCents = paymentCents - credit - apply,
    )
}

/** "Credit $10.00, apply $15.00, keep $0.00." */
fun decideSummaryLine(form: DecideForm.Ready): String =
    "Credit ${formatCentsUsd(form.creditCents)}, apply ${formatCentsUsd(form.applyCents)}, " +
        "keep ${formatCentsUsd(form.keepCents)}."

/**
 * The note after a save, built ONLY from the server's answer (never from what
 * the form asked for): "Decision saved. $10.00 to account credit (balance now
 * $37.00). $15.00 on invoice INV-1050 (paid in full). $0.00 kept on the payment."
 */
fun decisionResultText(res: ResolveUnappliedPaymentResult): String = buildString {
    append("Decision saved.")
    if (res.creditedCents > 0L) {
        append(" ${formatCentsUsd(res.creditedCents)} to account credit ")
        append("(balance now ${formatCentsUsd(res.newAccountBalanceCents)}).")
    }
    if (res.appliedCents > 0L) {
        val inv = res.appliedInvoiceNumber.trim().ifEmpty { res.appliedInvoiceId }
        val state = if (res.appliedInvoiceState == "settled") "paid in full"
        else "${formatCentsUsd(res.appliedInvoiceAmountDueCents)} still due"
        append(" ${formatCentsUsd(res.appliedCents)} on invoice $inv ($state).")
    }
    append(" ${formatCentsUsd(res.keptCents)} kept on the payment.")
}
