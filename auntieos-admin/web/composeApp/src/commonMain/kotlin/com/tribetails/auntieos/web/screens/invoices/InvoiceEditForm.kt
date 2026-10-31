package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlin.math.roundToLong

/**
 * The invoice editor (#1174) on the desktop console: the admin web's edit form
 * (`auntieos-admin/src/components/InvoiceDetail.tsx`, `startEditing` and
 * `saveEdit`), saved through the `updateInvoice` callable.
 *
 * Pure, so the gating and the payload are tested in jvmTest without a window.
 *
 * THE SAVE IS A PATCH, NEVER A REBUILT INVOICE. Only the fields the form
 * controls AND the operator changed go into it, so a field this form has no
 * control for (termsCode, sessionIds, every money figure the server derives)
 * cannot be wiped by a save. The household name, client, address and legacy
 * `discount` text are controlled since #1198 and go in only when changed. The
 * server's patch schema is `.strict()`, so the keys built here are exactly the
 * ones it names.
 */

/** The server's bounds, from `updateInvoice`'s zod schema. */
const val INVOICE_EDIT_MAX_UNIT_CENTS: Long = 10_000_000L
const val INVOICE_EDIT_MAX_QTY: Double = 999.0

/** The stored edit-scope stamp, as `domain.InvoiceEditScope` reads it on Android. */
enum class InvoiceEditScope { ALL, METADATA_ONLY, NONE }

/** Absent or unrecognized reads as [InvoiceEditScope.NONE]: nothing offered on a doc the server has not classified. */
fun invoiceEditScopeOf(invoice: Invoice): InvoiceEditScope = when (invoice.editScope?.trim()?.lowercase()) {
    "all" -> InvoiceEditScope.ALL
    "metadataonly" -> InvoiceEditScope.METADATA_ONLY
    else -> InvoiceEditScope.NONE
}

/** One stored line, in integer cents. */
data class InvoiceEditLineItem(
    val description: String,
    val qty: Double,
    val unitCents: Long,
    val discountCents: Long = 0L,
    /** The visit this line bills for, or `""` on a typed line (#408). */
    val sessionId: String = "",
)

/**
 * The stored lines, or NULL when the invoice was never itemized. Never throws:
 * a row that is not a usable line is dropped, and a value that is not a list
 * at all reads as not itemized, the same rule as Android's
 * `decodeInvoiceLineItems`.
 */
fun invoiceEditLinesOf(invoice: Invoice): List<InvoiceEditLineItem>? {
    val list = invoice.lineItems as? JsonArray ?: return null
    return list.mapNotNull { entry ->
        val obj = entry as? JsonObject ?: return@mapNotNull null
        val qty = (obj["qty"] as? JsonPrimitive)?.doubleOrNull ?: return@mapNotNull null
        val unitCents = (obj["unitCents"] as? JsonPrimitive)?.numberAsLong() ?: return@mapNotNull null
        if (!qty.isFinite()) return@mapNotNull null
        InvoiceEditLineItem(
            description = (obj["description"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty(),
            qty = qty,
            unitCents = unitCents,
            discountCents = (obj["discountCents"] as? JsonPrimitive)?.numberAsLong() ?: 0L,
            sessionId = (obj["sessionId"] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty(),
        )
    }
}

/** The stored whole-invoice discount in cents; 0 when absent or unreadable. */
fun invoiceDiscountCentsOf(invoice: Invoice): Long =
    (invoice.invoiceDiscountCents as? JsonPrimitive)?.numberAsLong() ?: 0L

internal fun JsonPrimitive.numberAsLong(): Long? {
    if (isString) return null
    longOrNull?.let { return it }
    return doubleOrNull?.takeIf { it.isFinite() }?.roundToLong()
}

// ── Money text, mirroring auntieos-admin/src/lib/invoiceMoneyInput.ts ─────────

// parseDollarsToCents and parseQty live in InvoiceComposer.kt (same package),
// which the new-invoice composer and this editor share (#1235).

private val ISO_DAY_RE = Regex("""^\d{4}-\d{2}-\d{2}$""")

/** 1250 to "12.50", for seeding an input. Always two decimals. */
fun centsToInputDollars(cents: Long): String {
    val abs = if (cents < 0) -cents else cents
    val frac = abs % 100
    return "${if (cents < 0) "-" else ""}${abs / 100}.${if (frac < 10) "0$frac" else "$frac"}"
}

/** "$36.00" / "-$12.50". */
fun formatEditCents(cents: Long): String =
    if (cents < 0) "-\$${centsToInputDollars(-cents)}" else "\$${centsToInputDollars(cents)}"

/** "3" for a whole quantity, "2.5" for a fractional one. */
fun formatEditQty(qty: Double): String {
    if (!qty.isFinite()) return "0"
    if (qty == qty.toLong().toDouble()) return qty.toLong().toString()
    val hundredths = (qty * 100).roundToLong()
    val frac = hundredths % 100
    val fracText = (if (frac < 10) "0$frac" else "$frac").trimEnd('0')
    return "${hundredths / 100}.$fracText"
}

/** One line's charge in cents, rounded once. */
fun lineAmountCents(line: InvoiceEditLineItem): Long =
    if (!line.qty.isFinite()) -line.discountCents else (line.qty * line.unitCents).roundToLong() - line.discountCents

/**
 * The server's `validateInvoiceMoney`, mirrored (Android's
 * `validateComposerMoney`): a line discount larger than its line, or a
 * whole-invoice discount larger than the subtotal, is refused and both figures
 * are named.
 */
fun validateInvoiceEditMoney(lines: List<InvoiceEditLineItem>, invoiceDiscountCents: Long): String? {
    for (li in lines) {
        val label = li.description.trim()
        if (label.isEmpty()) return "Every line item needs a description."
        if (!li.qty.isFinite() || li.qty <= 0.0) return "Quantity for \"$label\" must be greater than zero."
        if (li.discountCents < 0L) return "Discount for \"$label\" must be zero or more."
        val gross = (li.qty * li.unitCents).roundToLong()
        if (li.discountCents > gross) {
            return "Discount for \"$label\" (${formatEditCents(li.discountCents)}) is larger than the line itself " +
                "(${formatEditCents(gross)})."
        }
    }
    if (invoiceDiscountCents < 0L) return "Invoice discount must be zero or more."
    val subtotal = lines.sumOf { lineAmountCents(it) }
    if (invoiceDiscountCents > subtotal) {
        return "Invoice discount (${formatEditCents(invoiceDiscountCents)}) is larger than the subtotal " +
            "(${formatEditCents(subtotal)})."
    }
    return null
}

// ── The form ─────────────────────────────────────────────────────────────────

/** One row mid-edit. Text, because a half-typed field is not a number. */
data class InvoiceEditLine(
    val description: String = "",
    val qtyText: String = "1",
    val unitText: String = "",
    val discountText: String = "",
    /** A bound row (#408) is not editable: its money is the visit's. Carried through the save. */
    val sessionId: String = "",
) {
    val isBound: Boolean get() = sessionId.isNotBlank()
}

data class InvoiceEditDraft(
    val invoiceNumber: String,
    val date: String,
    val dueDate: String,
    val terms: String,
    val lines: List<InvoiceEditLine>,
    val invoiceDiscountText: String,
    /**
     * Whether the invoice HAD line items when editing began. Load-bearing: the
     * presence of `lineItems` in the patch itemizes an invoice, so a due-date
     * fix on an un-itemized one must not send `lineItems: []`.
     */
    val wasItemized: Boolean,
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
    val moneyEditable: Boolean get() = scope == InvoiceEditScope.ALL
}

fun invoiceEditLineOf(line: InvoiceEditLineItem): InvoiceEditLine = InvoiceEditLine(
    description = line.description,
    qtyText = formatEditQty(line.qty),
    unitText = centsToInputDollars(line.unitCents),
    discountText = if (line.discountCents > 0L) centsToInputDollars(line.discountCents) else "",
    sessionId = line.sessionId,
)

/** The form for [invoice], or NULL when its stored scope offers no edit. */
fun invoiceEditDraftOf(invoice: Invoice): InvoiceEditDraft? {
    val scope = invoiceEditScopeOf(invoice)
    if (scope == InvoiceEditScope.NONE) return null
    val stored = invoiceEditLinesOf(invoice)
    val discount = invoiceDiscountCentsOf(invoice)
    return InvoiceEditDraft(
        invoiceNumber = invoice.invoiceNumber,
        date = invoice.date,
        dueDate = invoice.dueDate,
        terms = invoice.terms,
        lines = stored.orEmpty().map(::invoiceEditLineOf),
        invoiceDiscountText = if (discount > 0L) centsToInputDollars(discount) else "",
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

data class InvoiceEditLinesParse(
    val lines: List<InvoiceEditLineItem>?,
    val invoiceDiscountCents: Long,
    val error: String?,
)

/** The rows as money, or the first reason they are not. Same sentences as web's `parseDraftLines`. */
fun invoiceEditLinesParse(rows: List<InvoiceEditLine>, invoiceDiscountText: String): InvoiceEditLinesParse {
    val lines = mutableListOf<InvoiceEditLineItem>()
    rows.forEachIndexed { i, d ->
        val description = d.description.trim()
        if (description.isEmpty()) return InvoiceEditLinesParse(null, 0L, "Line ${i + 1} needs a description.")
        val where = "\"$description\""
        val qty = parseQty(d.qtyText)
            ?: return InvoiceEditLinesParse(null, 0L, "Quantity for $where must be a number greater than zero.")
        if (qty > INVOICE_EDIT_MAX_QTY) {
            return InvoiceEditLinesParse(null, 0L, "Quantity for $where cannot be more than ${INVOICE_EDIT_MAX_QTY.toLong()}.")
        }
        val unitCents = parseDollarsToCents(d.unitText)
            ?: return InvoiceEditLinesParse(null, 0L, "Unit price for $where needs a dollar amount, for example 25.00.")
        if (unitCents > INVOICE_EDIT_MAX_UNIT_CENTS) {
            return InvoiceEditLinesParse(
                null,
                0L,
                "Unit price for $where cannot be more than ${formatEditCents(INVOICE_EDIT_MAX_UNIT_CENTS)}.",
            )
        }
        var discountCents = 0L
        if (d.discountText.isNotBlank()) {
            discountCents = parseDollarsToCents(d.discountText)
                ?: return InvoiceEditLinesParse(null, 0L, "Discount for $where needs a dollar amount, or leave it empty.")
        }
        lines.add(InvoiceEditLineItem(description, qty, unitCents, discountCents, d.sessionId))
    }
    var invoiceDiscountCents = 0L
    if (invoiceDiscountText.isNotBlank()) {
        invoiceDiscountCents = parseDollarsToCents(invoiceDiscountText)
            ?: return InvoiceEditLinesParse(null, 0L, "Invoice discount needs a dollar amount, or leave it empty.")
    }
    validateInvoiceEditMoney(lines, invoiceDiscountCents)?.let { return InvoiceEditLinesParse(null, 0L, it) }
    return InvoiceEditLinesParse(lines, invoiceDiscountCents, null)
}

/** The `patch` object to send, or the sentence that says why there is nothing to send. */
data class InvoiceEditPatchOutcome(val patch: JsonObject?, val error: String?)

private fun isIsoDay(value: String): Boolean {
    if (!ISO_DAY_RE.matches(value)) return false
    val month = value.substring(5, 7).toIntOrNull() ?: return false
    val day = value.substring(8, 10).toIntOrNull() ?: return false
    if (month !in 1..12) return false
    val daysInMonth = when (month) {
        1, 3, 5, 7, 8, 10, 12 -> 31
        4, 6, 9, 11 -> 30
        else -> 29
    }
    return day in 1..daysInMonth
}

/**
 * The `updateInvoice` patch for [draft] against the [invoice] it was opened on,
 * mirroring web's `saveEdit`: only CHANGED metadata; money only under scope
 * `all`, and then only when the invoice was itemized or now has lines, with
 * `lineItems` and `invoiceDiscountCents` together; an empty patch refused.
 */
fun invoiceEditPatchOf(invoice: Invoice, draft: InvoiceEditDraft): InvoiceEditPatchOutcome {
    val fields = LinkedHashMap<String, JsonElement>()
    if (draft.invoiceNumber != invoice.invoiceNumber) {
        val trimmed = draft.invoiceNumber.trim()
        if (trimmed.isEmpty()) return InvoiceEditPatchOutcome(null, "The invoice number cannot be empty.")
        fields["invoiceNumber"] = JsonPrimitive(trimmed)
    }
    if (draft.date != invoice.date) {
        val trimmed = draft.date.trim()
        if (!isIsoDay(trimmed)) return InvoiceEditPatchOutcome(null, "The invoice date needs to be a date like 2026-10-23.")
        fields["date"] = JsonPrimitive(trimmed)
    }
    if (draft.dueDate != invoice.dueDate) {
        val trimmed = draft.dueDate.trim()
        if (!isIsoDay(trimmed)) return InvoiceEditPatchOutcome(null, "The due date needs to be a date like 2026-10-23.")
        fields["dueDate"] = JsonPrimitive(trimmed)
    }
    if (draft.terms != invoice.terms) fields["terms"] = JsonPrimitive(draft.terms)
    // #1198: sent as typed, like `terms`, and only when changed. An emptied
    // field is a real edit (a wrong address cleared) and goes as "".
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
        fields[key] = JsonPrimitive(typed)
    }

    if (draft.moneyEditable) {
        val parsed = invoiceEditLinesParse(draft.lines, draft.invoiceDiscountText)
        val lines = parsed.lines ?: return InvoiceEditPatchOutcome(null, parsed.error)
        if (draft.wasItemized || lines.isNotEmpty()) {
            fields["lineItems"] = buildJsonArray { lines.forEach { add(it.toPatchJson()) } }
            fields["invoiceDiscountCents"] = JsonPrimitive(parsed.invoiceDiscountCents)
        }
    }

    if (fields.isEmpty()) return InvoiceEditPatchOutcome(null, "Nothing has changed yet.")
    return InvoiceEditPatchOutcome(JsonObject(fields), null)
}

/** One line in the patch's shape: a zero discount and a blank binding are omitted, as web does. */
fun InvoiceEditLineItem.toPatchJson(): JsonObject = buildJsonObject {
    put("description", JsonPrimitive(description))
    put("qty", JsonPrimitive(qty))
    put("unitCents", JsonPrimitive(unitCents))
    if (discountCents != 0L) put("discountCents", JsonPrimitive(discountCents))
    if (sessionId.isNotBlank()) put("sessionId", JsonPrimitive(sessionId))
}

data class InvoiceEditPreview(val totalCents: Long, val unreadable: Int)

/** The live total; a row mid-typing counts as unreadable rather than as zero. */
fun invoiceEditPreviewOf(rows: List<InvoiceEditLine>, invoiceDiscountText: String): InvoiceEditPreview {
    var total = 0L
    var unreadable = 0
    for (d in rows) {
        val qty = parseQty(d.qtyText)
        val unit = parseDollarsToCents(d.unitText)
        if (qty == null || unit == null) {
            unreadable += 1
            continue
        }
        val discount = if (d.discountText.isBlank()) 0L else parseDollarsToCents(d.discountText) ?: 0L
        total += lineAmountCents(InvoiceEditLineItem(d.description, qty, unit, discount))
    }
    val invoiceDiscount = if (invoiceDiscountText.isBlank()) 0L else parseDollarsToCents(invoiceDiscountText) ?: 0L
    return InvoiceEditPreview(total - invoiceDiscount, unreadable)
}

/** What the running total leaves out, or null when every row is readable. */
fun invoiceEditPendingCopy(unreadable: Int): String? = when (unreadable) {
    0 -> null
    1 -> "This total leaves out 1 line that still needs a quantity and a unit price."
    else -> "This total leaves out $unreadable lines that still need a quantity and a unit price."
}

/** "2 x $25.00, less $5.00" for a line shown read-only. */
fun invoiceEditLineSummary(line: InvoiceEditLine): String {
    val qty = parseQty(line.qtyText)
    val unit = parseDollarsToCents(line.unitText)
    if (qty == null || unit == null) return "${line.qtyText} x ${line.unitText}"
    val discount = if (line.discountText.isBlank()) 0L else parseDollarsToCents(line.discountText) ?: 0L
    return buildString {
        append(formatEditQty(qty)).append(" x ").append(formatEditCents(unit))
        if (discount > 0L) append(", less ").append(formatEditCents(discount))
    }
}

fun List<InvoiceEditLine>.movedBy(index: Int, delta: Int): List<InvoiceEditLine> {
    val target = index + delta
    if (index !in indices || target !in indices) return this
    val next = toMutableList()
    val moved = next[index]
    next[index] = next[target]
    next[target] = moved
    return next
}

fun List<InvoiceEditLine>.replacedAt(index: Int, value: InvoiceEditLine): List<InvoiceEditLine> =
    mapIndexed { i, existing -> if (i == index) value else existing }
