package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.contracts.UpdateInvoiceArgsPatch
import com.tribetails.auntieos.data.contracts.UpdateInvoiceArgsPatchLineItem
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.InvoiceLineItem
import com.tribetails.auntieos.domain.InvoiceEditScope
import com.tribetails.auntieos.domain.MAX_QTY
import com.tribetails.auntieos.domain.MAX_UNIT_CENTS
import com.tribetails.auntieos.domain.centsToInputDollars
import com.tribetails.auntieos.domain.formatCents
import com.tribetails.auntieos.domain.formatQty
import com.tribetails.auntieos.domain.invoiceDerivedTotalCents
import com.tribetails.auntieos.domain.invoiceEditScopeOf
import com.tribetails.auntieos.domain.invoiceLineItems
import com.tribetails.auntieos.domain.parseDollarsToCents
import com.tribetails.auntieos.domain.parseQty
import com.tribetails.auntieos.ui.admin.isValidNewInvoiceIsoDate
import com.tribetails.auntieos.ui.admin.validateComposerMoney

/**
 * The invoice editor (#1174): the admin web's edit form
 * (`auntieos-admin/src/components/InvoiceDetail.tsx`, `startEditing` and
 * `saveEdit`) on Android, saved through the `updateInvoice` callable.
 *
 * Pure, so the gating and the payload are unit-tested without a screen.
 *
 * THE SAVE IS A PATCH, NEVER A REBUILT INVOICE. `updateInvoice` takes a
 * `.strict()` patch, and this file only ever puts into it the fields the form
 * controls AND the operator changed. Nothing is read back out of the form into
 * an [Invoice] and written whole, so a field this form has no control for
 * (termsCode, sessionIds, the money the server derives) cannot be wiped by a
 * save. The household name, client, address and legacy `discount` text are
 * controlled since #1198, and go in only when changed, like the rest.
 */

/** One row mid-edit. Text, because a half-typed field is not a number. */
data class InvoiceEditLine(
    val description: String = "",
    val qtyText: String = "1",
    val unitText: String = "",
    val discountText: String = "",
    /**
     * The visit this line bills for, or `""` on a typed line (#408).
     *
     * A BOUND ROW IS NOT EDITABLE, same ruling as the web editor: its money is
     * the visit's, so the row offers the visit and a Remove, never four fields
     * to type over it with. It is carried through the save, because the patch
     * replaces `lineItems` wholesale and a dropped id would cut the line loose
     * from the work it bills for.
     */
    val sessionId: String = "",
) {
    val isBound: Boolean get() = sessionId.isNotBlank()
}

/** The whole form, opened from a stored invoice. */
data class InvoiceEditDraft(
    val invoiceNumber: String,
    val date: String,
    val dueDate: String,
    val terms: String,
    val lines: List<InvoiceEditLine>,
    val invoiceDiscountText: String,
    /**
     * Whether this invoice HAD line items when editing began.
     *
     * Load-bearing. `updateInvoice` recomputes the money of an itemized invoice
     * and leaves an un-itemized one alone, and the presence of `lineItems` in
     * the patch is what itemizes it. An edit that only fixes a due date must not
     * send `lineItems: []`, or a real $40 invoice becomes $0.
     */
    val wasItemized: Boolean,
    /** The STORED editScope when the form opened. Never re-derived from the money. */
    val scope: InvoiceEditScope,
    /**
     * The household name, client, billing address and legacy discount text
     * (#1198). No defaults: a draft that did not seed them from the invoice
     * would read every one as changed and blank it on save.
     */
    val kinfolkName: String,
    val client: String,
    val address: String,
    /** The LEGACY free-text discount ("10% loyalty"): display-only, never money. */
    val discount: String,
) {
    /** Lines and discounts are editable only under `all`; `metadataOnly` shows them read-only. */
    val moneyEditable: Boolean get() = scope == InvoiceEditScope.ALL
}

/** A stored line, opened for editing. Keeps its binding. */
fun invoiceEditLineOf(line: InvoiceLineItem): InvoiceEditLine = InvoiceEditLine(
    description = line.description,
    qtyText = formatQty(line.qty),
    unitText = centsToInputDollars(line.unitCents),
    discountText = if (line.discountCents > 0L) centsToInputDollars(line.discountCents) else "",
    sessionId = line.sessionId,
)

/**
 * The form for [invoice], or NULL when the stored scope offers no edit.
 *
 * The stored `editScope` decides only whether to OFFER the form, exactly as on
 * web; the server still enforces on the write and its refusal is shown
 * verbatim. An absent or unknown scope reads as `none` (see
 * `invoiceEditScopeOf`), so nothing is offered for a doc the server has not
 * classified.
 */
fun invoiceEditDraftOf(invoice: Invoice): InvoiceEditDraft? {
    val scope = invoiceEditScopeOf(invoice)
    if (scope == InvoiceEditScope.NONE) return null
    val stored = invoiceLineItems(invoice)
    return InvoiceEditDraft(
        invoiceNumber = invoice.invoiceNumber,
        date = invoice.date,
        dueDate = invoice.dueDate,
        terms = invoice.terms,
        lines = stored.orEmpty().map(::invoiceEditLineOf),
        invoiceDiscountText = if (invoice.invoiceDiscountCents > 0L) centsToInputDollars(invoice.invoiceDiscountCents) else "",
        wasItemized = stored != null,
        scope = scope,
        kinfolkName = invoice.kinfolkName,
        client = invoice.client,
        address = invoice.address,
        discount = invoice.discount,
    )
}
/**
 * `updateInvoice`'s zod `.max()` for the four descriptive fields (#1198), with
 * the label the dialog shows. Checked before the round trip so an over-long
 * address gets a sentence naming the field instead of a generic refusal.
 */
internal val INVOICE_EDIT_HEADER_TEXT_MAX: Map<String, Pair<String, Int>> = mapOf(
    "kinfolkName" to ("Household" to 200),
    "client" to ("Client" to 200),
    "address" to ("Address" to 500),
    "discount" to ("Discount note" to 200),
)

/** What [invoiceEditLinesParse] made of the rows. [lines] is null when any row could not be read. */
data class InvoiceEditLinesParse(
    val lines: List<InvoiceLineItem>?,
    val invoiceDiscountCents: Long,
    val error: String?,
)

/**
 * The rows as money, or the first reason they are not. Same rules and the same
 * sentences as the web editor's `parseDraftLines`: a row is never partly
 * salvaged, and the server's own bounds and money validator run here as a
 * courtesy before the round trip.
 */
fun invoiceEditLinesParse(rows: List<InvoiceEditLine>, invoiceDiscountText: String): InvoiceEditLinesParse {
    val lines = mutableListOf<InvoiceLineItem>()
    rows.forEachIndexed { i, d ->
        val description = d.description.trim()
        if (description.isEmpty()) return InvoiceEditLinesParse(null, 0L, "Line ${i + 1} needs a description.")
        val where = "\"$description\""
        val qty = parseQty(d.qtyText)
            ?: return InvoiceEditLinesParse(null, 0L, "Quantity for $where must be a number greater than zero.")
        if (qty > MAX_QTY) {
            return InvoiceEditLinesParse(null, 0L, "Quantity for $where cannot be more than ${MAX_QTY.toLong()}.")
        }
        val unitCents = parseDollarsToCents(d.unitText)
            ?: return InvoiceEditLinesParse(null, 0L, "Unit price for $where needs a dollar amount, for example 25.00.")
        if (unitCents > MAX_UNIT_CENTS) {
            return InvoiceEditLinesParse(
                null,
                0L,
                "Unit price for $where cannot be more than ${formatCents(MAX_UNIT_CENTS)}.",
            )
        }
        var discountCents = 0L
        if (d.discountText.isNotBlank()) {
            discountCents = parseDollarsToCents(d.discountText)
                ?: return InvoiceEditLinesParse(null, 0L, "Discount for $where needs a dollar amount, or leave it empty.")
        }
        lines.add(
            InvoiceLineItem(
                description = description,
                qty = qty,
                unitCents = unitCents,
                discountCents = discountCents,
                sessionId = d.sessionId,
            ),
        )
    }
    var invoiceDiscountCents = 0L
    if (invoiceDiscountText.isNotBlank()) {
        invoiceDiscountCents = parseDollarsToCents(invoiceDiscountText)
            ?: return InvoiceEditLinesParse(null, 0L, "Invoice discount needs a dollar amount, or leave it empty.")
    }
    validateComposerMoney(lines, invoiceDiscountCents)?.let { return InvoiceEditLinesParse(null, 0L, it) }
    return InvoiceEditLinesParse(lines, invoiceDiscountCents, null)
}

/** The patch to send, or the sentence that says why there is nothing to send. */
data class InvoiceEditPatchOutcome(val patch: UpdateInvoiceArgsPatch?, val error: String?)

/**
 * The `updateInvoice` patch for [draft] against the [invoice] it was opened on.
 *
 * Mirrors web's `saveEdit` field for field:
 *  - ONLY CHANGED metadata goes in. An echoed value would still stamp
 *    `updatedAt` and write an audit entry for an edit that did not happen.
 *  - Money goes in ONLY under scope `all`, and then only when the invoice was
 *    itemized or now has lines (the un-itemized guard on [InvoiceEditDraft.wasItemized]).
 *    When it goes, `lineItems` and `invoiceDiscountCents` go together.
 *  - An empty patch is refused here, as the server refuses it.
 */
fun invoiceEditPatchOf(invoice: Invoice, draft: InvoiceEditDraft): InvoiceEditPatchOutcome {
    var invoiceNumber: String? = null
    var date: String? = null
    var dueDate: String? = null
    var terms: String? = null

    if (draft.invoiceNumber != invoice.invoiceNumber) {
        val trimmed = draft.invoiceNumber.trim()
        if (trimmed.isEmpty()) return InvoiceEditPatchOutcome(null, "The invoice number cannot be empty.")
        invoiceNumber = trimmed
    }
    if (draft.date != invoice.date) {
        val trimmed = draft.date.trim()
        if (!isValidNewInvoiceIsoDate(trimmed)) {
            return InvoiceEditPatchOutcome(null, "The invoice date needs to be a date like 2026-10-23.")
        }
        date = trimmed
    }
    if (draft.dueDate != invoice.dueDate) {
        val trimmed = draft.dueDate.trim()
        if (!isValidNewInvoiceIsoDate(trimmed)) {
            return InvoiceEditPatchOutcome(null, "The due date needs to be a date like 2026-10-23.")
        }
        dueDate = trimmed
    }
    if (draft.terms != invoice.terms) terms = draft.terms
    // #1198: sent as typed, like `terms`, and only when changed. An emptied
    // field is a real edit (a wrong address cleared) and goes as "".
    val header = linkedMapOf<String, String>()
    for ((key, pair) in listOf(
        "kinfolkName" to (draft.kinfolkName to invoice.kinfolkName),
        "client" to (draft.client to invoice.client),
        "address" to (draft.address to invoice.address),
        "discount" to (draft.discount to invoice.discount),
    )) {
        val (typed, stored) = pair
        if (typed == stored) continue
        val (label, max) = INVOICE_EDIT_HEADER_TEXT_MAX.getValue(key)
        if (typed.length > max) return InvoiceEditPatchOutcome(null, "$label cannot be more than $max characters.")
        header[key] = typed
    }

    var lineItems: List<UpdateInvoiceArgsPatchLineItem>? = null
    var invoiceDiscountCents: Long? = null
    if (draft.moneyEditable) {
        val parsed = invoiceEditLinesParse(draft.lines, draft.invoiceDiscountText)
        if (parsed.error != null || parsed.lines == null) return InvoiceEditPatchOutcome(null, parsed.error)
        val touchedMoney = draft.wasItemized || parsed.lines.isNotEmpty()
        if (touchedMoney) {
            lineItems = parsed.lines.map { it.toUpdateInvoiceLine() }
            invoiceDiscountCents = parsed.invoiceDiscountCents
        }
    }

    val patch = UpdateInvoiceArgsPatch(
        invoiceNumber = invoiceNumber,
        date = date,
        dueDate = dueDate,
        terms = terms,
        kinfolkName = header["kinfolkName"],
        client = header["client"],
        address = header["address"],
        discount = header["discount"],
        lineItems = lineItems,
        invoiceDiscountCents = invoiceDiscountCents,
    )
    if (patch.toPayload().isEmpty()) return InvoiceEditPatchOutcome(null, "Nothing has changed yet.")
    return InvoiceEditPatchOutcome(patch, null)
}

/** Android's [InvoiceLineItem] as the `updateInvoice` patch's line shape. */
fun InvoiceLineItem.toUpdateInvoiceLine(): UpdateInvoiceArgsPatchLineItem = UpdateInvoiceArgsPatchLineItem(
    description = description,
    qty = qty,
    unitCents = unitCents,
    // Omitted when zero, as web does: "no discount" is the absence of one.
    discountCents = discountCents.takeIf { it != 0L },
    sessionId = sessionId.takeIf { it.isNotBlank() },
)

/** What the editable rows add up to so far, and how many rows cannot be read yet. */
data class InvoiceEditPreview(val totalCents: Long, val unreadable: Int)

/**
 * The live total under the editor. A row mid-typing contributes nothing and is
 * COUNTED as unreadable, so the total never silently means less than it shows.
 */
fun invoiceEditPreviewOf(rows: List<InvoiceEditLine>, invoiceDiscountText: String): InvoiceEditPreview {
    val readable = mutableListOf<InvoiceLineItem>()
    var unreadable = 0
    for (d in rows) {
        val qty = parseQty(d.qtyText)
        val unit = parseDollarsToCents(d.unitText)
        if (qty == null || unit == null) {
            unreadable += 1
            continue
        }
        val discount = if (d.discountText.isBlank()) 0L else parseDollarsToCents(d.discountText) ?: 0L
        readable.add(InvoiceLineItem(description = d.description, qty = qty, unitCents = unit, discountCents = discount))
    }
    val invoiceDiscount = if (invoiceDiscountText.isBlank()) 0L else parseDollarsToCents(invoiceDiscountText) ?: 0L
    return InvoiceEditPreview(invoiceDerivedTotalCents(readable, invoiceDiscount), unreadable)
}

/** The rows with [index] swapped one step by [delta]; unchanged when that would leave the list. */
fun List<InvoiceEditLine>.movedBy(index: Int, delta: Int): List<InvoiceEditLine> {
    val target = index + delta
    if (index !in indices || target !in indices) return this
    val next = toMutableList()
    val moved = next[index]
    next[index] = next[target]
    next[target] = moved
    return next
}

/** The rows with [index] replaced. */
fun List<InvoiceEditLine>.replacedAt(index: Int, value: InvoiceEditLine): List<InvoiceEditLine> =
    mapIndexed { i, existing -> if (i == index) value else existing }
