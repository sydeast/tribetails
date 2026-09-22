package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.Payment

sealed interface InvoiceDetailState {
    object Loading : InvoiceDetailState
    data class Loaded(val invoice: Invoice) : InvoiceDetailState
    object NotFound : InvoiceDetailState
    data class Err(val message: String) : InvoiceDetailState
}

fun invoiceDetailStateFor(
    invoiceId: String,
    result: FirestoreResult<List<Invoice>>,
): InvoiceDetailState = when (result) {
    FirestoreResult.Loading    -> InvoiceDetailState.Loading
    is FirestoreResult.Error   -> InvoiceDetailState.Err(result.message)
    is FirestoreResult.Data    -> {
        val found = result.value.firstOrNull { it._id == invoiceId }
        if (found != null) InvoiceDetailState.Loaded(found) else InvoiceDetailState.NotFound
    }
}

/**
 * Unified billing status for an invoice. The list/detail screens previously
 * only knew PAID vs OUTSTANDING (amountDue <= 0). This folds in OVERDUE so a
 * still-owed invoice whose [Invoice.dueDate] is in the past reads distinctly.
 */
enum class InvoiceStatus { PAID, OVERDUE, OUTSTANDING }

/**
 * Pure status resolver. [todayKey] is an ISO date prefix (YYYY-MM-DD) for
 * "today" so the comparison stays testable and clock-free.
 *
 * - amountDue <= 0  -> PAID
 * - [invoiceIsOverdue]: stored state `open` AND dueDate strictly before today -> OVERDUE
 * - otherwise -> OUTSTANDING
 *
 * #871: OVERDUE comes from the shared [invoiceIsOverdue], so the detail badge,
 * the list pill and the server's overdue notice agree. It used to call any
 * still-owed invoice with a past date overdue, cancelled and quotes included.
 */
fun invoiceStatusFor(invoice: Invoice, todayKey: String): InvoiceStatus {
    if (invoice.amountDue <= 0.0) return InvoiceStatus.PAID
    return if (invoiceIsOverdue(invoice, todayKey)) InvoiceStatus.OVERDUE else InvoiceStatus.OUTSTANDING
}

/** True only when both look like YYYY-MM-DD and [a] is strictly before [b]. */
fun isIsoDateBefore(a: String, b: String): Boolean {
    if (!looksLikeIsoDate(a) || !looksLikeIsoDate(b)) return false
    return a < b // lexicographic compare is correct for zero-padded YYYY-MM-DD
}

private fun looksLikeIsoDate(s: String): Boolean =
    s.length == 10 && s[4] == '-' && s[7] == '-' &&
        s[0].isDigit() && s[1].isDigit() && s[2].isDigit() && s[3].isDigit() &&
        s[5].isDigit() && s[6].isDigit() && s[8].isDigit() && s[9].isDigit()

/**
 * Best-effort payment grouping for the detail screen. The [Payment] model has
 * NO invoiceId (or any per-invoice foreign key), so a payment cannot be joined
 * to a specific invoice with confidence. This returns payments for the same
 * kinfolk as a DISCLOSED heuristic only; callers must surface that these are
 * client-level, not invoice-linked. Returns empty when [kinfolkId] is blank.
 */
fun paymentsForKinfolk(payments: List<Payment>, kinfolkId: String): List<Payment> {
    if (kinfolkId.isBlank()) return emptyList()
    return payments.filter { it.kinfolkId == kinfolkId }
}

/**
 * Payments confidently linked to a specific invoice via the populated
 * [Payment.invoiceId] (written by match_payments_to_invoices.py and by the
 * Record-Payment-on-detail flow). This is the REAL per-invoice join, unlike the
 * disclosed kinfolk-level heuristic above. Returns empty when [invoiceId] is blank.
 */
fun paymentsForInvoice(payments: List<Payment>, invoiceId: String): List<Payment> {
    if (invoiceId.isBlank()) return emptyList()
    return payments.filter { it.invoiceId == invoiceId }
}

/**
 * Build a [Payment] prefilled from an invoice for the Record-Payment dialog,
 * crucially stamping [Payment.invoiceId]/[Payment.invoiceNumber] so the per-invoice
 * join ([paymentsForInvoice]) is populated going forward (spec 17 item 6). Pure;
 * unit-tested.
 */
fun buildInvoicePayment(
    invoice: Invoice,
    amount: Double,
    paymentMethod: String,
    referenceNumber: String,
    date: String,
    notes: String,
): Payment = Payment(
    kinfolkId = invoice.kinfolkId,
    kinfolkName = invoice.kinfolkName,
    date = date.trim(),
    paymentMethod = paymentMethod.trim(),
    referenceNumber = referenceNumber.trim(),
    amount = amount,
    notes = notes.trim(),
    invoiceId = invoice._id,
    invoiceNumber = invoice.invoiceNumber,
)
