package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.floor
import kotlin.math.roundToLong

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
    /**
     * #1240: what has been collected and what is left, when the invoice is
     * part paid. Another display refinement of OPEN, never its own state. The
     * screen relabels the Amount due card "Still owed" when this is set.
     */
    val partPaid: InvoicePartPayment? = null,
)

/**
 * #1240: what has been collected against an invoice, and what is left, in
 * integer cents.
 *
 * PART PAID IS A DISPLAY REFINEMENT OF [InvoiceState.OPEN], NOT A NINTH
 * STATE, exactly like overdue: it changes the pill and the copy and never the
 * actions offered, so a part-paid invoice keeps Record payment for collecting
 * the rest. The same rule as web `lib/invoiceFormat.ts#invoicePartialPayment`
 * and Android `domain/InvoiceActions.kt#invoicePartPaid`.
 *
 * READS [Invoice.paidCents], NEVER `total - amountDue`. Those are float
 * dollars, and on every invoice the pre-2026-07-25 write touched `amountDue`
 * reads 0 while a real balance is owed, so the subtraction would report the
 * whole total as collected on exactly the rows that are wrong. An invoice with
 * no readable `paidCents` is not claimed to be part paid.
 */
data class InvoicePartPayment(val paidCents: Long, val remainingCents: Long)

/**
 * The stored `paidCents` when it is a whole number, else null. Strict on
 * purpose, as web's `Number.isInteger`: a string, a fraction, a non-finite
 * number or an explicit null is not a record of a payment, and rounding 12.5
 * up to 13 would make a claim the doc does not.
 */
fun invoicePaidCentsOf(invoice: Invoice): Long? {
    val p = invoice.paidCents as? JsonPrimitive ?: return null
    if (p.isString) return null
    p.longOrNull?.let { return it }
    val d = p.doubleOrNull ?: return null
    if (!d.isFinite() || d != floor(d)) return null
    return d.toLong()
}

fun invoicePartPaidOf(invoice: Invoice): InvoicePartPayment? {
    if (invoiceStateOrNull(invoice) != InvoiceState.OPEN) return null
    val paidCents = invoicePaidCentsOf(invoice) ?: return null
    if (paidCents <= 0L) return null
    val amountDue = invoice.amountDue.takeIf { it.isFinite() } ?: 0.0
    val remainingCents = (amountDue * 100.0).roundToLong()
    if (remainingCents <= 0L) return null
    return InvoicePartPayment(paidCents = paidCents, remainingCents = remainingCents)
}

/** The balance card's and row's label: "Still owed" on a part-paid invoice, as on web and Android. */
fun invoiceAmountDueLabelFor(badge: InvoiceDetailBadge): String =
    if (badge.partPaid != null) "Still owed" else "Amount due"

/** "$20.00 of $40.00 paid": names both figures, as Android's card does. */
fun invoicePartPaidTrend(invoice: Invoice, part: InvoicePartPayment): String =
    "${formatEditCents(part.paidCents)} of ${formatMoney(invoice.total)} paid"

/**
 * Overdue outranks the stamp's own pill, as on web and Android. PART PAID
 * ranks below overdue and above the stamp's own pill: an overdue invoice that
 * is also part paid is, first, overdue. A doc with no recognisable stamp shows
 * its own stored word, uppercased, and never a state guessed from the money
 * fields.
 *
 * The trend line under the card names the payment already collected whenever
 * the invoice is part paid, overdue or not, as Android's does: showing only
 * what is left would hide the money already taken.
 */
fun invoiceDetailBadgeFor(invoice: Invoice, todayKey: String): InvoiceDetailBadge {
    val state = invoiceStateOrNull(invoice)
    val overdue = invoiceIsOverdue(invoice, todayKey)
    val partPaid = invoicePartPaidOf(invoice)
    val due = invoice.dueDate.trim().take(10)
    if (overdue) {
        val trend = partPaid?.let { invoicePartPaidTrend(invoice, it) } ?: "past due $due"
        return InvoiceDetailBadge(state, true, "OVERDUE", AuntieStatusTone.Error, trend, partPaid)
    }
    if (partPaid != null) {
        return InvoiceDetailBadge(
            state, false, "PART PAID", AuntieStatusTone.Purple, invoicePartPaidTrend(invoice, partPaid), partPaid,
        )
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

/**
 * #1239: the stored total and the lines beside it, when they disagree.
 *
 * REACHABLE, NOT DEFENSIVE THEATRE. `firestore.rules` lets any staff
 * credential update the invoices collection directly, and `postInvoiceEvent`
 * merges an arbitrary payload; both bypass every callable that keeps the
 * stored total in step with the lines.
 *
 * NAME BOTH FIGURES, RECONCILE NEITHER. Nothing here picks a winner, shows
 * the derived figure in place of the stored one, or writes a correction: the
 * operator is the only one who knows which number is true. The same rule as
 * web `lib/invoiceReconcile.ts#checkInvoiceTotal` and Android
 * `domain/InvoiceLineItems.kt#invoiceTotalDisagreement`.
 */
data class InvoiceTotalDisagreement(
    /** What the lines add up to, less the whole-invoice discount. */
    val derivedCents: Long,
    /** What the doc claims. */
    val storedCents: Long,
    /** Which field [storedCents] came from, so the banner can say. */
    val storedFrom: InvoiceStoredTotalField,
)

enum class InvoiceStoredTotalField { TOTAL_CENTS, TOTAL }

/**
 * Null when there is nothing to compare or nothing differs. An un-itemized
 * invoice has no lines to disagree with. An itemized-as-empty one is still
 * compared: its lines come to nothing less the discount.
 *
 * `totalCents` is preferred over the dollar `total` whenever it is readable,
 * because it is the exact integer the server wrote. This follows web, which
 * keys on the field's PRESENCE; Android keys on `totalCents != 0` only because
 * its model cannot tell absent from zero, and this one can. The dollar
 * fallback is rounded to cents, so a float artifact never reads as drift.
 *
 * One limit, shared with Android: [Invoice.total] decodes an absent field as
 * 0.0, so an itemized invoice with neither total field reads as claiming $0.
 */
fun invoiceTotalDisagreementOf(invoice: Invoice): InvoiceTotalDisagreement? {
    val lines = invoiceEditLinesOf(invoice) ?: return null
    val derived = lines.sumOf { lineAmountCents(it) } - invoiceDiscountCentsOf(invoice)
    val exact = (invoice.totalCents as? JsonPrimitive)?.numberAsLong()
    val (stored, from) = if (exact != null) {
        exact to InvoiceStoredTotalField.TOTAL_CENTS
    } else {
        val dollars = invoice.total.takeIf { it.isFinite() } ?: 0.0
        (dollars * 100.0).roundToLong() to InvoiceStoredTotalField.TOTAL
    }
    return if (stored == derived) null else InvoiceTotalDisagreement(derived, stored, from)
}

const val INVOICE_TOTAL_DISAGREEMENT_TITLE: String = "This invoice disagrees with itself"

/** The banner body: both figures, where the stored one lives, and what fixes it. Web's and Android's copy. */
fun invoiceTotalDisagreementText(d: InvoiceTotalDisagreement): String {
    val source = when (d.storedFrom) {
        InvoiceStoredTotalField.TOTAL_CENTS -> "the total stored on the invoice"
        InvoiceStoredTotalField.TOTAL -> "the total stored on the invoice (its legacy dollar field)"
    }
    return "The line items add up to ${formatEditCents(d.derivedCents)}, but $source says " +
        "${formatEditCents(d.storedCents)}. Nothing has been changed to make them match, and nothing will be. " +
        "The household is billed the stored figure. Re-saving the line items through Edit will recompute " +
        "the stored total from them, if the lines are the version you want to keep."
}
