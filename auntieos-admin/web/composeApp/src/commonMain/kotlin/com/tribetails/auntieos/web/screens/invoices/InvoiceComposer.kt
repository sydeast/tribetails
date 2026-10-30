package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.InvoiceLineItem
import com.tribetails.auntieos.web.data.UninvoicedSession
import kotlin.math.roundToLong

/**
 * #1178: everything the desktop new-invoice composer decides, with no Compose in
 * it. A port of the Android `ui/admin/InvoiceComposer.kt` (#408) so the three
 * admin clients build an invoice the same way: pick a household, tick its
 * un-invoiced visits, add extra lines, pick terms. Every function is pure and
 * unit-tested in `InvoiceComposerTest`.
 *
 * What the old desktop form asked for, and where each answer comes from now:
 *   Invoice number   assigned by the server (`lib/invoiceNumber.ts`).
 *   Client           the household.
 *   Date             today, editable.
 *   Due date         worked out from the terms; typed only on custom terms.
 *   Total / due      worked out from the lines. Typed only on the blank path,
 *                    which exists for a household with no logged work, as it
 *                    does on web and Android.
 *   Status           a new invoice is a draft. Sending is
 *                    `reviewAndSendDraftInvoice`, from the invoice itself.
 *
 * Money is integer cents. Nothing here falls back to zero on a bad parse.
 */

/** The largest unit price the server's zod schema accepts: $100,000.00. */
const val MAX_UNIT_CENTS: Long = 10_000_000L

/** The largest quantity the server's zod schema accepts. */
const val MAX_QTY: Double = 999.0

private val MONEY_RE = Regex("""^\d+(\.\d{1,2})?$""")

/** "12.50" to 1250, or null. Accepts a leading `$` and thousands commas; refuses a third decimal. */
fun parseDollarsToCents(raw: String): Long? {
    val s = raw.trim().removePrefix("$").replace(",", "")
    if (s.isEmpty() || !MONEY_RE.matches(s)) return null
    val dollars = s.toDoubleOrNull() ?: return null
    if (!dollars.isFinite()) return null
    return (dollars * 100).roundToLong()
}

/** "2.5" to 2.5, or null for anything that is not a positive quantity. */
fun parseQty(raw: String): Double? {
    val s = raw.trim()
    if (s.isEmpty() || !MONEY_RE.matches(s)) return null
    val qty = s.toDoubleOrNull() ?: return null
    if (!qty.isFinite() || qty <= 0.0) return null
    return qty
}

/** Integer cents as the dollars float `invoices.total` / `amountDue` store. A projection, never an input. */
fun centsToDollars(cents: Long): Double = cents.toDouble() / 100.0

/** "$36.00" from integer cents. */
fun formatInvoiceCents(cents: Long): String = formatMoney(cents / 100.0)

/** One line's charge in whole cents, rounded half-up once. */
fun lineAmountCents(line: InvoiceLineItem): Long {
    if (!line.qty.isFinite()) return -line.discountCents
    return (line.qty * line.unitCents).roundToLong() - line.discountCents
}

/** Sum of the line amounts, before any whole-invoice discount. */
fun invoiceSubtotalCents(lines: List<InvoiceLineItem>): Long = lines.sumOf { lineAmountCents(it) }

/** Which path this invoice is being written down. WORK is the default; BLANK is for a household with no logged work. */
enum class InvoiceCreatePath { WORK, BLANK }

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Aug 11", or "Aug 11, 2025" when not this year. Falls back to the raw text. */
fun visitDayLabel(raw: String, todayIso: String): String {
    val iso = raw.trim().take(10)
    if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(iso)) return raw.trim()
    val month = iso.substring(5, 7).toIntOrNull() ?: return raw.trim()
    val name = MONTHS.getOrNull(month - 1) ?: return raw.trim()
    val day = iso.substring(8, 10).toIntOrNull() ?: return raw.trim()
    val year = iso.substring(0, 4)
    return if (year != todayIso.take(4)) "$name $day, $year" else "$name $day"
}

/** How a visit reads on an invoice line: the service, and the day it happened. */
fun visitLineDescription(session: UninvoicedSession): String {
    val label = session.serviceType.trim().ifBlank { "Visit" }
    val day = session.startTime.take(10)
    return if (day.isBlank()) label else "$label, $day"
}

/** A YYYY-MM-DD that parses to a real calendar date (February 29 allowed every year, as on web and Android). */
internal fun isValidNewInvoiceIsoDate(value: String): Boolean {
    val s = value.trim()
    if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(s)) return false
    val month = s.substring(5, 7).toIntOrNull() ?: return false
    val day = s.substring(8, 10).toIntOrNull() ?: return false
    if (month !in 1..12) return false
    val daysInMonth = when (month) {
        1, 3, 5, 7, 8, 10, 12 -> 31
        4, 6, 9, 11 -> 30
        else -> 29
    }
    return day in 1..daysInMonth
}

/** The lines a set of ticked visits produces, or the first problem with them. */
data class BoundLinesOutcome(val lines: List<InvoiceLineItem>, val error: String?)

/**
 * The invoice lines for the ticked visits. Each carries its `sessionId`. A visit
 * the rate card could not price needs a typed price; until it has one this
 * refuses rather than billing zero. Quantity is one visit.
 */
fun buildBoundLines(
    sessions: List<UninvoicedSession>,
    selected: Set<String>,
    prices: Map<String, String>,
): BoundLinesOutcome {
    val lines = mutableListOf<InvoiceLineItem>()
    for (s in sessions) {
        if (s.sessionId !in selected) continue
        val description = visitLineDescription(s)
        var unitCents = s.unitCents
        if (unitCents == null) {
            val typed = (prices[s.sessionId] ?: "").trim()
            if (typed.isEmpty()) {
                return BoundLinesOutcome(
                    emptyList(),
                    "$description has no rate on file. Type what it should cost, or untick it.",
                )
            }
            val parsed = parseDollarsToCents(typed)
                ?: return BoundLinesOutcome(
                    emptyList(),
                    "The price for $description needs a dollar amount, for example 25.00.",
                )
            if (parsed > MAX_UNIT_CENTS) {
                return BoundLinesOutcome(
                    emptyList(),
                    "The price for $description cannot be more than ${formatInvoiceCents(MAX_UNIT_CENTS)}.",
                )
            }
            unitCents = parsed
        }
        lines.add(InvoiceLineItem(description = description, qty = 1.0, unitCents = unitCents, sessionId = s.sessionId))
    }
    return BoundLinesOutcome(lines, null)
}

/** One typed extra charge, before it is money. */
data class ComposerDraftLine(
    val description: String = "",
    val qtyText: String = "1",
    val unitText: String = "",
    val discountText: String = "",
)

/** What [parseDraftLines] made of the typed rows. [lines] is null when any row could not be read. */
data class DraftLinesOutcome(val lines: List<InvoiceLineItem>?, val invoiceDiscountCents: Long, val error: String?)

/** Typed rows to lines, or the first row that cannot be read. A row is never partially salvaged. */
fun parseDraftLines(drafts: List<ComposerDraftLine>, invoiceDiscountText: String): DraftLinesOutcome {
    val lines = mutableListOf<InvoiceLineItem>()
    drafts.forEachIndexed { i, d ->
        val description = d.description.trim()
        if (description.isEmpty()) return DraftLinesOutcome(null, 0L, "Line ${i + 1} needs a description.")
        val where = "\"$description\""
        val qty = parseQty(d.qtyText)
            ?: return DraftLinesOutcome(null, 0L, "Quantity for $where must be a number greater than zero.")
        if (qty > MAX_QTY) {
            return DraftLinesOutcome(null, 0L, "Quantity for $where cannot be more than ${MAX_QTY.toLong()}.")
        }
        val unitCents = parseDollarsToCents(d.unitText)
            ?: return DraftLinesOutcome(null, 0L, "Unit price for $where needs a dollar amount, for example 25.00.")
        if (unitCents > MAX_UNIT_CENTS) {
            return DraftLinesOutcome(
                null,
                0L,
                "Unit price for $where cannot be more than ${formatInvoiceCents(MAX_UNIT_CENTS)}.",
            )
        }
        // A blank discount is "no discount", the one field where absence is zero.
        var discountCents = 0L
        if (d.discountText.trim().isNotEmpty()) {
            discountCents = parseDollarsToCents(d.discountText)
                ?: return DraftLinesOutcome(null, 0L, "Discount for $where needs a dollar amount, or leave it empty.")
        }
        lines.add(InvoiceLineItem(description = description, qty = qty, unitCents = unitCents, discountCents = discountCents))
    }
    var invoiceDiscountCents = 0L
    if (invoiceDiscountText.trim().isNotEmpty()) {
        invoiceDiscountCents = parseDollarsToCents(invoiceDiscountText)
            ?: return DraftLinesOutcome(null, 0L, "Invoice discount needs a dollar amount, or leave it empty.")
    }
    return DraftLinesOutcome(lines, invoiceDiscountCents, null)
}

/** Mirrors the server's `validateInvoiceMoney`. Names the numbers. Null when sound. */
fun validateComposerMoney(lines: List<InvoiceLineItem>, invoiceDiscountCents: Long): String? {
    for (li in lines) {
        val label = li.description.trim()
        if (label.isEmpty()) return "Every line item needs a description."
        if (!li.qty.isFinite() || li.qty <= 0.0) return "Quantity for \"$label\" must be greater than zero."
        if (li.discountCents < 0L) return "Discount for \"$label\" must be zero or more."
        val gross = (li.qty * li.unitCents).roundToLong()
        if (li.discountCents > gross) {
            return "Discount for \"$label\" (${formatInvoiceCents(li.discountCents)}) is larger than the line itself " +
                "(${formatInvoiceCents(gross)})."
        }
    }
    if (invoiceDiscountCents < 0L) return "Invoice discount must be zero or more."
    val subtotal = invoiceSubtotalCents(lines)
    if (invoiceDiscountCents > subtotal) {
        return "Invoice discount (${formatInvoiceCents(invoiceDiscountCents)}) is larger than the subtotal " +
            "(${formatInvoiceCents(subtotal)})."
    }
    return null
}

/** What the work path adds up to. [lines] is null the moment anything cannot be read. */
data class ComposerMoney(
    val lines: List<InvoiceLineItem>?,
    val invoiceDiscountCents: Long,
    val totalCents: Long,
    val error: String?,
)

/** The lines and total from the ticked visits plus the typed extra charges. */
fun composerMoney(
    sessions: List<UninvoicedSession>,
    selected: Set<String>,
    prices: Map<String, String>,
    drafts: List<ComposerDraftLine>,
    invoiceDiscountText: String,
): ComposerMoney {
    val bound = buildBoundLines(sessions, selected, prices)
    if (bound.error != null) return ComposerMoney(null, 0L, 0L, bound.error)
    val typed = parseDraftLines(drafts, invoiceDiscountText)
    if (typed.error != null || typed.lines == null) {
        return ComposerMoney(null, 0L, 0L, typed.error ?: "Those extra charges could not be read.")
    }
    val lines = bound.lines + typed.lines
    val moneyError = validateComposerMoney(lines, typed.invoiceDiscountCents)
    if (moneyError != null) return ComposerMoney(null, 0L, 0L, moneyError)
    return ComposerMoney(
        lines = lines,
        invoiceDiscountCents = typed.invoiceDiscountCents,
        totalCents = lines.sumOf { lineAmountCents(it) } - typed.invoiceDiscountCents,
        error = null,
    )
}

/** Validation for the BLANK path, the only one where a total is typed. No invoice number, no amount due. */
fun validateBlankInvoice(kinfolkId: String, totalText: String, date: String, dueDate: String): String? {
    // The same money parser as every other figure here, so "NaN", "1e5" and a
    // third decimal are refused rather than sent.
    val totalCents = parseDollarsToCents(totalText)
    return when {
        kinfolkId.isBlank() -> "Pick a household for this invoice"
        totalCents == null -> "Total must be a dollar amount of zero or more, for example 120.00"
        date.isNotBlank() && !isValidNewInvoiceIsoDate(date) -> "Date must be a real YYYY-MM-DD date"
        dueDate.isNotBlank() && !isValidNewInvoiceIsoDate(dueDate) -> "Due date must be a real YYYY-MM-DD date"
        else -> null
    }
}

/** Why the create button cannot run yet, or null when it can. Shown beside the disabled button. */
fun composerBlockedReason(
    kinfolkId: String,
    path: InvoiceCreatePath,
    termsCode: InvoiceTermsCode,
    due: DueDateResolution,
    date: String,
    customDueDate: String,
    selectedCount: Int,
    draftCount: Int,
    money: ComposerMoney?,
    totalText: String,
): String? {
    if (kinfolkId.isBlank()) return "Pick a household first."
    if (date.isNotBlank() && !isValidNewInvoiceIsoDate(date)) return "Date must be a real YYYY-MM-DD date"
    if (termsCode == InvoiceTermsCode.CUSTOM) {
        if (customDueDate.isNotBlank() && !isValidNewInvoiceIsoDate(customDueDate)) {
            return "Due date must be a real YYYY-MM-DD date"
        }
    } else if (due.dueDate == null) {
        return due.problem
    }
    return when (path) {
        InvoiceCreatePath.WORK -> when {
            selectedCount == 0 && draftCount == 0 -> "Tick the work this invoice covers, or add a line of your own."
            money?.error != null -> money.error
            else -> null
        }
        InvoiceCreatePath.BLANK -> validateBlankInvoice(kinfolkId, totalText, date, customDueDate)
    }
}

/** The create button's words. Counts the visits it is about to bill for. */
fun composerCreateLabel(isQuote: Boolean, visitCount: Int): String {
    val verb = if (isQuote) "Create quote" else "Create invoice"
    if (visitCount <= 0) return verb
    return "$verb for $visitCount visit${if (visitCount == 1) "" else "s"}"
}

/** What the due-date field is doing. */
fun composerTermsNote(termsCode: InvoiceTermsCode, due: DueDateResolution, invoiceDate: String): String = when {
    termsCode == InvoiceTermsCode.CUSTOM -> "These terms leave the due date to you."
    due.dueDate == null -> due.problem.orEmpty()
    due.isPast ->
        "Worked out from the terms, counting from ${due.basisDay ?: invoiceDate}. That date has already " +
            "passed, so this invoice is overdue the moment it goes out."
    else -> "Worked out from the terms, counting from ${due.basisDay ?: invoiceDate}."
}

/** The line above the visit list: how much of the household's work is ticked, or that there is none. */
fun uninvoicedScopeLine(
    householdLabel: String,
    total: Int,
    selectedCount: Int,
    scanned: Long,
    narrowedFrom: String?,
    narrowedTo: String?,
): String {
    val window = if (narrowedFrom != null && narrowedTo != null) " between $narrowedFrom and $narrowedTo" else ""
    return if (total == 0) {
        "No un-invoiced completed visits for $householdLabel$window. $scanned visits were checked."
    } else {
        "$selectedCount of $total un-invoiced visit${if (total == 1) "" else "s"} selected for $householdLabel$window."
    }
}

/** The do-not-invoice button's words. Keeps its verb at zero; the button is disabled instead. */
fun doNotInvoiceLabel(count: Int): String = when (count) {
    0 -> "Do not invoice"
    1 -> "Do not invoice this visit"
    else -> "Do not invoice these $count visits"
}

/** What happened after the queue changed. Counts CHANGED visits, not requested ones. */
fun exclusionNotice(changedCount: Int, doNotInvoice: Boolean): String {
    val subject = if (changedCount == 1) "1 visit is" else "$changedCount visits are"
    return if (doNotInvoice) {
        val obj = if (changedCount == 1) "it" else "them"
        "$subject marked do not invoice, and off this list until you put $obj back."
    } else {
        "$subject back in this household's un-invoiced work."
    }
}

/** The heading over the excluded visits. */
fun excludedWorkLine(count: Int): String = if (count == 1) {
    "1 completed visit is marked do not invoice, so it is not on the list above."
} else {
    "$count completed visits are marked do not invoice, so they are not on the list above."
}

/**
 * Everything the composer decided, in one piece. A REQUEST, NOT A DOCUMENT.
 * [lineItems] null is the blank path and is not the same as an empty list; see
 * `createInvoicePayload`.
 */
data class NewInvoiceRequest(
    val isQuote: Boolean,
    val invoice: Invoice,
    val sendToKinfolk: Boolean = false,
    val termsCode: String? = null,
    val lineItems: List<InvoiceLineItem>? = null,
    val invoiceDiscountCents: Long? = null,
)

/** What [buildNewInvoiceRequest] produced: a request, or the reason there is none. */
data class NewInvoiceBuild(val request: NewInvoiceRequest?, val error: String?)

/**
 * The submit step, as a pure function: the composer's state in, the request
 * `createInvoice` / `createQuote` is sent out. The dialog calls this and nothing
 * else decides what goes on the wire.
 *
 * A new invoice is a draft; a quote leaves `status` blank because the server
 * forces QUOTE. `client` is the household. No invoice number: the server assigns
 * one. On the work path both dollar scalars are the projection of the same cents
 * total the server recomputes from the lines.
 */
fun buildNewInvoiceRequest(
    isQuote: Boolean,
    kinfolkId: String,
    kinfolkName: String,
    path: InvoiceCreatePath,
    date: String,
    termsCode: InvoiceTermsCode,
    due: DueDateResolution,
    customDueDate: String,
    money: ComposerMoney?,
    totalText: String,
    sendToKinfolk: Boolean,
): NewInvoiceBuild {
    val dueDate = if (termsCode == InvoiceTermsCode.CUSTOM) customDueDate.trim() else due.dueDate.orEmpty()
    val base = Invoice(
        kinfolkId = kinfolkId,
        kinfolkName = kinfolkName,
        client = kinfolkName,
        date = date.trim(),
        dueDate = dueDate,
        status = if (isQuote) "" else "draft",
    )
    return when (path) {
        InvoiceCreatePath.WORK -> {
            val lines = money?.lines
            if (money == null || lines == null || lines.isEmpty()) {
                return NewInvoiceBuild(null, money?.error ?: "This invoice has no work on it yet.")
            }
            val dollars = centsToDollars(money.totalCents)
            NewInvoiceBuild(
                NewInvoiceRequest(
                    isQuote = isQuote,
                    invoice = base.copy(
                        total = dollars,
                        amountDue = dollars,
                        sessionIds = lines.mapNotNull { it.sessionId.takeIf(String::isNotBlank) },
                    ),
                    sendToKinfolk = isQuote && sendToKinfolk,
                    termsCode = termsCode.wire,
                    lineItems = lines,
                    invoiceDiscountCents = money.invoiceDiscountCents,
                ),
                null,
            )
        }
        InvoiceCreatePath.BLANK -> {
            val typedCents = parseDollarsToCents(totalText)
                ?: return NewInvoiceBuild(null, "Total must be a dollar amount of zero or more, for example 120.00")
            val typed = centsToDollars(typedCents)
            NewInvoiceBuild(
                NewInvoiceRequest(
                    isQuote = isQuote,
                    invoice = base.copy(total = typed, amountDue = typed),
                    sendToKinfolk = isQuote && sendToKinfolk,
                    termsCode = termsCode.wire,
                    lineItems = null,
                    invoiceDiscountCents = null,
                ),
                null,
            )
        }
    }
}
