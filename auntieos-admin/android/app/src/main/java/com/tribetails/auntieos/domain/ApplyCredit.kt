package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice

/**
 * #1872 (operator ruling 2026-11-11): account credit goes onto an invoice only
 * as an amount the admin enters. Nothing spends it automatically. The pure
 * half of that one box on the invoice. Every string here is shared word for
 * word with the web admin (`lib/applyCreditFormat.ts`) and the desktop console.
 * The server makes every check again (`admin/applyAccountCredit.ts`).
 */

sealed interface ApplyCreditForm {
    data class Ready(val amountCents: Long) : ApplyCreditForm
    data class Invalid(val message: String) : ApplyCreditForm
}

/** Reads the amount box against what the household holds and what the invoice owes. */
fun parseApplyCreditAmount(amountText: String, availableCents: Long, dueCents: Long?): ApplyCreditForm {
    val cents = parseDollarsToCents(amountText)
        ?: return ApplyCreditForm.Invalid("Enter an amount in dollars, like 25.00.")
    if (cents <= 0L) return ApplyCreditForm.Invalid("Enter an amount above $0.00.")
    if (cents > availableCents) {
        return ApplyCreditForm.Invalid(
            "This household has ${formatCentsUsd(availableCents)} of account credit. Enter that much or less.",
        )
    }
    if (dueCents != null && cents > dueCents) {
        return ApplyCreditForm.Invalid(
            "This invoice has ${formatCentsUsd(dueCents)} left to pay. Enter that much or less.",
        )
    }
    return ApplyCreditForm.Ready(cents)
}

/** "invoice 1026", or "this invoice" when it has no number. Never a stored id. */
fun applyCreditInvoiceWords(invoiceNumber: String?): String {
    val n = invoiceNumber.orEmpty().trim()
    return if (n.isEmpty()) "this invoice" else "invoice $n"
}

/** The confirmation: the amount, the invoice, and what both balances become. */
fun applyCreditConfirmText(amountCents: Long, invoiceNumber: String?, availableCents: Long, dueCents: Long?): String {
    val lead = "Apply ${formatCentsUsd(amountCents)} of account credit to ${applyCreditInvoiceWords(invoiceNumber)}?"
    val credit = "The household keeps ${formatCentsUsd(availableCents - amountCents)} of credit."
    if (dueCents == null) return "$lead $credit"
    val left = dueCents - amountCents
    val invoice = if (left == 0L) "The invoice will be paid." else "The invoice will have ${formatCentsUsd(left)} left to pay."
    return "$lead $invoice $credit"
}

/** After the save, from the SERVER's figures only. */
fun creditAppliedText(appliedCents: Long, amountDueCents: Long, accountBalanceCents: Long, invoiceNumber: String?): String {
    val lead = "Applied ${formatCentsUsd(appliedCents)} of account credit to ${applyCreditInvoiceWords(invoiceNumber)}."
    val invoice = if (amountDueCents == 0L) "The invoice is paid." else "${formatCentsUsd(amountDueCents)} is left to pay."
    return "$lead $invoice The household has ${formatCentsUsd(accountBalanceCents)} of credit left."
}

/** The line beside the title: what the household holds. */
fun availableCreditLine(availableCents: Long): String =
    if (availableCents > 0L) "${formatCentsUsd(availableCents)} available" else "This household has no account credit."

/**
 * Whether the invoice detail offers the Account credit box. The SAME stored
 * state answer that offers Record payment, so a draft, a quote and a paid
 * invoice never show it, and never on an archived invoice (the server refuses
 * that one by name).
 */
fun applyCreditOffered(invoice: Invoice): Boolean =
    InvoiceAction.RECORD_PAYMENT in invoiceActionsFor(invoiceStateOrNull(invoice)) && !invoiceIsArchived(invoice)

/** What the invoice still owes for the box's own check, or null when no figure can be trusted. */
fun applyCreditDueCents(ledgerAmountDueCents: Long?, invoice: Invoice): Long? =
    ledgerAmountDueCents ?: invoice.amountDueCents.takeIf { it > 0L }
