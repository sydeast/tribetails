package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone

/**
 * #1199: what the invoice detail screen says the invoice IS, and what it billed.
 * Pure, so jvmTest pins both without a window.
 *
 * THE BADGE READS THE STORED STAMP (ADR-0002), never `amountDue`. The server
 * classified the doc in the same write that last moved its money; web
 * (`InvoiceDetail.tsx`, `invoiceStamp` + `invoiceStateInfo`) and Android
 * (`InvoiceDetailScreen.kt`, `statusTriple`) read that verdict, and so does
 * this screen now. The old resolver here returned PAID whenever
 * `amountDue <= 0`, so a credit read as paid, and a draft or a quote with a
 * balance read as outstanding.
 */
data class InvoiceDetailBadge(
    /** The decoded stamp, or null when the doc carries none this build knows. */
    val state: InvoiceState?,
    /** A display refinement of OPEN, never its own state. */
    val overdue: Boolean,
    /** The pill text. */
    val label: String,
    val tone: AuntieStatusTone,
    /** The line under the Amount due card. */
    val amountTrend: String,
)

/**
 * Overdue outranks the stamp's own pill, as on web and Android. A doc with no
 * recognisable stamp shows its own stored word, uppercased, and never a state
 * guessed from the money fields.
 */
fun invoiceDetailBadgeFor(invoice: Invoice, todayKey: String): InvoiceDetailBadge {
    val state = invoiceStateOrNull(invoice)
    val overdue = invoiceIsOverdue(invoice, todayKey)
    val due = invoice.dueDate.trim().take(10)
    if (overdue) {
        return InvoiceDetailBadge(state, true, "OVERDUE", AuntieStatusTone.Error, "past due $due")
    }
    fun badge(label: String, tone: AuntieStatusTone, trend: String) =
        InvoiceDetailBadge(state, false, label, tone, trend)
    return when (state) {
        InvoiceState.OPEN -> badge("OUTSTANDING", AuntieStatusTone.Warning, "due ${due.ifBlank { "soon" }}")
        InvoiceState.PAID -> badge("PAID", AuntieStatusTone.Success, "paid in full")
        InvoiceState.DRAFT -> badge("DRAFT", AuntieStatusTone.Muted, "not sent yet")
        InvoiceState.QUOTE -> badge("QUOTE", AuntieStatusTone.Purple, "quoted, not billed")
        InvoiceState.CANCELLED -> badge("CANCELLED", AuntieStatusTone.Muted, "cancelled")
        InvoiceState.CREDIT -> badge("CREDIT", AuntieStatusTone.Teal, "credit owed to the household")
        InvoiceState.REDEEMED -> badge("REDEEMED", AuntieStatusTone.Muted, "credit redeemed")
        InvoiceState.ZERO -> badge("ZERO", AuntieStatusTone.Muted, "nothing billed")
        null -> badge(
            invoice.status.trim().uppercase().ifBlank { "NO STATUS" },
            AuntieStatusTone.Muted,
            invoice.status.trim().ifBlank { "no status on record" },
        )
    }
}

/** One stored line as the detail screen prints it. */
data class InvoiceDetailLineRow(
    /** The stored description, or "no description" when it was lost. */
    val description: String,
    val descriptionMissing: Boolean,
    /** "3 x $25.00", plus ", less $5.00" when the line carries a discount. */
    val detail: String,
    val amountCents: Long,
    /** The visit this line bills for (#408), or null on a typed line. */
    val boundSessionId: String?,
)

/**
 * The Line items panel's three cases. ABSENT IS NOT EMPTY: an invoice that was
 * never itemized gets a sentence, because a heading over no rows reads as
 * "nothing was billed", which is a different and worse claim.
 */
sealed interface InvoiceDetailLinesPanel {
    data object NotItemized : InvoiceDetailLinesPanel
    data object ItemizedEmpty : InvoiceDetailLinesPanel
    data class Lines(
        val rows: List<InvoiceDetailLineRow>,
        val subtotalCents: Long,
        /** Whole-invoice discount; the panel prints its row only when above zero. */
        val invoiceDiscountCents: Long,
        /** What the lines come to after that discount. Not clamped at zero, as on the server. */
        val totalCents: Long,
    ) : InvoiceDetailLinesPanel
}

/** The copy for the two no-rows cases, the same sentences Android shows. */
fun invoiceDetailLinesEmptyCopy(panel: InvoiceDetailLinesPanel): String? = when (panel) {
    InvoiceDetailLinesPanel.NotItemized -> "No itemized breakdown. This invoice's total was entered directly."
    InvoiceDetailLinesPanel.ItemizedEmpty -> "Itemized as billing nothing: there is a breakdown, and it is empty."
    is InvoiceDetailLinesPanel.Lines -> null
}

/** The note under a bound line: its figure is the visit's (#408). */
const val INVOICE_DETAIL_BOUND_LINE_NOTE: String =
    "Billed from a visit, so this figure is the visit's. Change it there and this line follows."

fun invoiceDetailLinesPanelOf(invoice: Invoice): InvoiceDetailLinesPanel {
    val lines = invoiceEditLinesOf(invoice) ?: return InvoiceDetailLinesPanel.NotItemized
    if (lines.isEmpty()) return InvoiceDetailLinesPanel.ItemizedEmpty
    val rows = lines.map { line ->
        val missing = line.description.isBlank()
        InvoiceDetailLineRow(
            description = if (missing) "no description" else line.description,
            descriptionMissing = missing,
            detail = buildString {
                append(formatEditQty(line.qty))
                append(" x ")
                append(formatEditCents(line.unitCents))
                if (line.discountCents > 0) {
                    append(", less ")
                    append(formatEditCents(line.discountCents))
                }
            },
            amountCents = lineAmountCents(line),
            boundSessionId = line.sessionId.trim().ifBlank { null },
        )
    }
    val subtotal = rows.sumOf { it.amountCents }
    val discount = invoiceDiscountCentsOf(invoice)
    return InvoiceDetailLinesPanel.Lines(rows, subtotal, discount, subtotal - discount)
}
