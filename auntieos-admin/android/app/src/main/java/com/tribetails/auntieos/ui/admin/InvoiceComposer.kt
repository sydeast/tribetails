package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.contracts.CreateInvoiceArgsLineItem
import com.tribetails.auntieos.data.contracts.CreateQuoteArgsLineItem
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.model.InvoiceLineItem
import com.tribetails.auntieos.domain.DueDateResolution
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.domain.MAX_QTY
import com.tribetails.auntieos.domain.MAX_UNIT_CENTS
import com.tribetails.auntieos.domain.formatCents
import com.tribetails.auntieos.domain.invoiceSubtotalCents
import com.tribetails.auntieos.domain.lineAmountCents
import com.tribetails.auntieos.domain.parseDollarsToCents
import com.tribetails.auntieos.domain.parseQty
import kotlin.math.roundToLong

/**
 * Everything the Android new-invoice composer decides, with no Compose in it.
 *
 * CREATING AN INVOICE IS AN ACT OF SELECTION OVER WORK THAT ALREADY EXISTS, NOT
 * AN ACT OF DESCRIPTION. That is the finding behind issue #408, and it is the
 * rule this file encodes: which lines a selection of visits produces, what the
 * create button can and cannot do yet, and what to say when it cannot. Every
 * function here is pure and unit-tested, so the sentences the operator reads are
 * asserted rather than eyeballed on a device.
 *
 * WHAT THE FORM NO LONGER ASKS, and where each answer comes from instead:
 *
 *   Invoice number   assigned by the server (`lib/invoiceNumber.ts`), and
 *                    editable afterwards on the invoice itself. The old dialog
 *                    REQUIRED one and refused a blank.
 *   Client           the household, one field above. Inherited.
 *   Address          NOT ASKED AND NOT INHERITED: the kinfolk model carries no
 *                    postal address to inherit one from. The field stays on the
 *                    invoice and settable through `updateInvoice`; inventing a
 *                    household address field to fill it here is different work.
 *   Date             today, which is what a new invoice's date is.
 *   Due date         worked out from the terms.
 *   Terms            a structured choice rather than free text, which is what
 *                    lets the due date be worked out at all.
 *   Amount due       the total, on an invoice nobody has paid yet. A computed
 *                    output that was being asked for as an input.
 *   Discount         one field, in dollars, parsed to cents. The old dialog had
 *                    a free-text box beside a typed dollar one.
 *   Status           a new invoice is a draft. Sending it is a separate action
 *                    (`reviewAndSendDraftInvoice`) and always was; the dropdown
 *                    let an invoice be born "sent" with nothing sent.
 *
 * MONEY IS INTEGER CENTS HERE. The old composer read every money field as
 * `toDoubleOrNull() ?: 0.0`, which turned a typo into a free service that looked
 * deliberate on the finished bill. Nothing in this file falls back to zero.
 */

/** Invoice or quote. A quote is the same document in QUOTE status, not a second kind of thing. */
enum class InvoiceCreateKind(val optionLabel: String) {
    INVOICE("An invoice, for work already done"),
    QUOTE("A quote, for work not agreed yet"),
}

/**
 * Which path this invoice is being written down.
 *
 *   WORK    the invoice is a SELECTION over work that already exists. The
 *           default, and the whole point of #408.
 *   BLANK   nothing has been logged for this household, so a total is typed.
 *           A real need, and the exception rather than the front door.
 */
enum class InvoiceCreatePath { WORK, BLANK }

private val MONTHS = listOf(
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

/**
 * A day as the operator reads it: "Aug 11", or "Aug 11, 2025" when it is not
 * this year. Falls back to the raw text rather than blanking it, because an
 * unreadable date on a visit is worth seeing.
 */
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
fun visitLineDescription(session: ListUninvoicedSessionsResultSession): String {
    val label = session.serviceType.trim().ifBlank { "Visit" }
    val day = session.startTime.take(10)
    return if (day.isBlank()) label else "$label, $day"
}

/**
 * A YYYY-MM-DD that parses to a real calendar date.
 *
 * Kept as it was, February 29 permitted in every year and all, because the blank
 * path has always accepted it and the web port copied this rule verbatim so the
 * two forms would refuse the same things. The terms resolver uses the exact
 * `domain.isCalendarDay` instead, because it decides when money is owed.
 */
fun isValidNewInvoiceIsoDate(value: String): Boolean {
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
 * The invoice lines for a selection of visits.
 *
 * EVERY LINE CARRIES ITS `sessionId`, which is what makes it a bound line rather
 * than a description that happens to mention a date: the invoice can be routed
 * back to the work it bills for, and the household's copy can show when that
 * work happened.
 *
 * A VISIT THE RATE CARD COULD NOT PRICE NEEDS A TYPED ONE, and until it has one
 * this refuses rather than billing zero. Same rule the picker renders and the
 * same rule `listUninvoicedSessions` applies: null is not zero.
 */
fun buildBoundLines(
    sessions: List<ListUninvoicedSessionsResultSession>,
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
                    "The price for $description cannot be more than ${formatCents(MAX_UNIT_CENTS)}.",
                )
            }
            unitCents = parsed
        }
        // Quantity is ONE VISIT, not a duration. The rate card is keyed by
        // service name and priced per service, so multiplying by hours would
        // silently multiply the bill.
        lines.add(
            InvoiceLineItem(
                description = description,
                qty = 1.0,
                unitCents = unitCents,
                sessionId = s.sessionId,
            ),
        )
    }
    return BoundLinesOutcome(lines, null)
}

/**
 * One typed extra charge, as it sits in the composer before it is money.
 *
 * An extra charge is an ORDINARY LINE, not a special field: a mileage charge and
 * a dog walk are both things this invoice bills for, and giving one of them its
 * own box is how the old form ended up with a "Discount" text field beside a
 * dollar one.
 */
data class ComposerDraftLine(
    val description: String = "",
    val qtyText: String = "1",
    val unitText: String = "",
    val discountText: String = "",
)

/** What [parseDraftLines] made of the typed rows. [lines] is null when any row could not be read. */
data class DraftLinesOutcome(
    val lines: List<InvoiceLineItem>?,
    val invoiceDiscountCents: Long,
    val error: String?,
)

/**
 * Turns the typed rows into the shape the callable takes, or explains why it
 * cannot. The single boundary between text and money in the composer.
 *
 * A ROW IS NEVER PARTIALLY SALVAGED. If a price will not parse, the whole parse
 * fails and names the row. Dropping the bad row and submitting the rest would
 * quietly bill less than the operator entered, and submitting it as 0 would bill
 * nothing for it; both are worse than refusing and saying which row is wrong.
 *
 * The bounds checked here are the SERVER's, from its zod schema. Checking them
 * on the device is a courtesy that saves a round trip; the server still checks,
 * because a UI rule is not a rule.
 */
fun parseDraftLines(drafts: List<ComposerDraftLine>, invoiceDiscountText: String): DraftLinesOutcome {
    val lines = mutableListOf<InvoiceLineItem>()

    drafts.forEachIndexed { i, d ->
        val description = d.description.trim()
        if (description.isEmpty()) {
            return DraftLinesOutcome(null, 0L, "Line ${i + 1} needs a description.")
        }
        val where = "\"$description\""

        val qty = parseQty(d.qtyText)
            ?: return DraftLinesOutcome(null, 0L, "Quantity for $where must be a number greater than zero.")
        if (qty > MAX_QTY) {
            return DraftLinesOutcome(null, 0L, "Quantity for $where cannot be more than ${MAX_QTY.toLong()}.")
        }

        // Named explicitly rather than defaulted, which is the same rule
        // `listUninvoicedSessions` applies to an unpriceable visit: never invent
        // a number for a reading that failed.
        val unitCents = parseDollarsToCents(d.unitText)
            ?: return DraftLinesOutcome(null, 0L, "Unit price for $where needs a dollar amount, for example 25.00.")
        if (unitCents > MAX_UNIT_CENTS) {
            return DraftLinesOutcome(
                null,
                0L,
                "Unit price for $where cannot be more than ${formatCents(MAX_UNIT_CENTS)}.",
            )
        }

        // A blank discount is genuinely "no discount", not an unreadable figure,
        // so it is the one field where absence maps to zero.
        var discountCents = 0L
        if (d.discountText.trim().isNotEmpty()) {
            discountCents = parseDollarsToCents(d.discountText)
                ?: return DraftLinesOutcome(null, 0L, "Discount for $where needs a dollar amount, or leave it empty.")
        }

        lines.add(
            InvoiceLineItem(
                description = description,
                qty = qty,
                unitCents = unitCents,
                discountCents = discountCents,
            ),
        )
    }

    var invoiceDiscountCents = 0L
    if (invoiceDiscountText.trim().isNotEmpty()) {
        invoiceDiscountCents = parseDollarsToCents(invoiceDiscountText)
            ?: return DraftLinesOutcome(null, 0L, "Invoice discount needs a dollar amount, or leave it empty.")
    }

    return DraftLinesOutcome(lines, invoiceDiscountCents, null)
}

/**
 * Refuses money that would be a lie if stored. Returns the first problem as
 * operator-facing text, or null when the set is sound.
 *
 * Mirrors `validateInvoiceMoney` in the server's `lib/invoiceMath.ts`, minus the
 * integer checks Kotlin's `Long` makes unrepresentable. Fail loud and NAME THE
 * NUMBERS: "discount is larger than the subtotal" without the two figures leaves
 * the operator guessing which one to change.
 */
fun validateComposerMoney(lines: List<InvoiceLineItem>, invoiceDiscountCents: Long): String? {
    for (li in lines) {
        val label = li.description.trim()
        if (label.isEmpty()) return "Every line item needs a description."
        if (!li.qty.isFinite() || li.qty <= 0.0) {
            return "Quantity for \"$label\" must be greater than zero."
        }
        if (li.discountCents < 0L) {
            return "Discount for \"$label\" must be zero or more."
        }
        // Compared against the pre-discount charge, so the message can name it.
        val gross = (li.qty * li.unitCents).roundToLong()
        if (li.discountCents > gross) {
            return "Discount for \"$label\" (${formatCents(li.discountCents)}) is larger than the line itself " +
                "(${formatCents(gross)})."
        }
    }
    if (invoiceDiscountCents < 0L) return "Invoice discount must be zero or more."
    val subtotal = invoiceSubtotalCents(lines)
    if (invoiceDiscountCents > subtotal) {
        return "Invoice discount (${formatCents(invoiceDiscountCents)}) is larger than the subtotal " +
            "(${formatCents(subtotal)})."
    }
    return null
}

/** What the whole work path adds up to, and the first thing wrong with it. */
data class ComposerMoney(
    val lines: List<InvoiceLineItem>?,
    val invoiceDiscountCents: Long,
    val totalCents: Long,
    val error: String?,
)

/**
 * The lines this invoice would carry and the total under them, from the ticked
 * visits plus whatever extra charges were typed.
 *
 * Returns a null [ComposerMoney.lines] the moment anything cannot be read, so no
 * caller can accidentally submit a partial set.
 */
fun composerMoney(
    sessions: List<ListUninvoicedSessionsResultSession>,
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

/**
 * Pure validation for the BLANK path, the only one where a total is typed.
 *
 * `invoiceNumber` and `amountDue` are gone from it, and neither was a rule this
 * form should have enforced. The number is assigned by the server when nobody
 * supplies one; the amount due on an invoice nobody has paid is definitionally
 * its total, a computed output that was being asked for as an input.
 */
fun validateBlankInvoice(
    kinfolkId: String,
    totalText: String,
    date: String,
    dueDate: String,
): String? {
    val total = totalText.trim().toDoubleOrNull()
    return when {
        kinfolkId.isBlank() -> "Pick a household for this invoice"
        totalText.isBlank() || total == null || total < 0.0 -> "Total must be zero or greater"
        date.isNotBlank() && !isValidNewInvoiceIsoDate(date) -> "Date must be a real YYYY-MM-DD date"
        dueDate.isNotBlank() && !isValidNewInvoiceIsoDate(dueDate) -> "Due date must be a real YYYY-MM-DD date"
        else -> null
    }
}

/**
 * Why the create button cannot run yet, or null when it can.
 *
 * A SENTENCE rather than a boolean, because the button is shown DISABLED WITH
 * ITS REASON STATED beside it rather than hidden. A control that vanishes
 * teaches nothing about what it wanted.
 */
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
    if (date.isNotBlank() && !isValidNewInvoiceIsoDate(date)) {
        return "Date must be a real YYYY-MM-DD date"
    }
    if (termsCode == InvoiceTermsCode.CUSTOM) {
        if (customDueDate.isNotBlank() && !isValidNewInvoiceIsoDate(customDueDate)) {
            return "Due date must be a real YYYY-MM-DD date"
        }
    } else if (due.dueDate == null) {
        return due.problem
    }
    return when (path) {
        InvoiceCreatePath.WORK -> when {
            selectedCount == 0 && draftCount == 0 ->
                "Tick the work this invoice covers, or add a line of your own."
            money?.error != null -> money.error
            else -> null
        }
        InvoiceCreatePath.BLANK -> validateBlankInvoice(
            kinfolkId = kinfolkId,
            totalText = totalText,
            date = date,
            dueDate = customDueDate,
        )
    }
}

/**
 * The create button's words.
 *
 * IT COUNTS WHAT IT IS ABOUT TO BILL FOR, and follows the ticks as they change.
 * "Save" said nothing about what saving would do.
 *
 * NO BUSY VARIANT, because `PrimaryButton` swaps the whole label for a spinner
 * while `loading` is set: a "Creating invoice" string here would never reach a
 * screen. The verb is therefore the same one the operator pressed, throughout.
 */
fun composerCreateLabel(kind: InvoiceCreateKind, visitCount: Int): String {
    val verb = if (kind == InvoiceCreateKind.QUOTE) "Create quote" else "Create invoice"
    if (visitCount <= 0) return verb
    return "$verb for $visitCount visit${if (visitCount == 1) "" else "s"}"
}

/** What the due-date field is doing, and why it is not typeable. Said once. */
fun composerTermsNote(termsCode: InvoiceTermsCode, due: DueDateResolution, invoiceDate: String): String = when {
    termsCode == InvoiceTermsCode.CUSTOM -> "These terms leave the due date to you."
    due.dueDate == null -> due.problem.orEmpty()
    due.isPast ->
        "Worked out from the terms, counting from ${due.basisDay ?: invoiceDate}. That date has already " +
            "passed, so this invoice is overdue the moment it goes out."
    else ->
        "Worked out from the terms, counting from ${due.basisDay ?: invoiceDate}. Choose \"A date I pick " +
            "myself\" to set it by hand."
}

/**
 * The line above the visit list: how much of this household's outstanding work
 * is ticked, or that there is none and how hard it looked.
 *
 * NAMES THE HOUSEHOLD, THE RANGE AND WHAT WAS CHECKED. "No results" over a list
 * the operator cannot see the query for is how the old date-windowed picker sent
 * people away from work that was sitting five weeks back.
 */
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
        "$selectedCount of $total un-invoiced visit${if (total == 1) "" else "s"} selected for " +
            "$householdLabel$window."
    }
}

/**
 * The do-not-invoice button's words, for a selection of [count] visits.
 *
 * The SAME VERB the confirm step uses, and it keeps that verb when the selection
 * is empty rather than being relabelled into one. The button is disabled with
 * its reason beside it instead.
 */
fun doNotInvoiceLabel(count: Int): String = when (count) {
    0 -> "Do not invoice"
    1 -> "Do not invoice this visit"
    else -> "Do not invoice these $count visits"
}

/**
 * What happened, after the queue changed. Counts CHANGED visits, not requested
 * ones: re-marking a visit somebody already marked is a no-op, and reporting it
 * as a change would make the confirmation lie.
 */
fun exclusionNotice(changedCount: Int, doNotInvoice: Boolean): String {
    val subject = if (changedCount == 1) "1 visit is" else "$changedCount visits are"
    return if (doNotInvoice) {
        val obj = if (changedCount == 1) "it" else "them"
        "$subject marked do not invoice, and off this list until you put $obj back."
    } else {
        "$subject back in this household's un-invoiced work."
    }
}

/** The excluded-work heading, which says why those visits are not on the list above. */
fun excludedWorkLine(count: Int): String = if (count == 1) {
    "1 completed visit is marked do not invoice, so it is not on the list above."
} else {
    "$count completed visits are marked do not invoice, so they are not on the list above."
}

/** Android's [InvoiceLineItem] as the `createInvoice` request's line shape. */
fun InvoiceLineItem.toCreateInvoiceLine(): CreateInvoiceArgsLineItem = CreateInvoiceArgsLineItem(
    description = description,
    qty = qty,
    unitCents = unitCents,
    // Omitted when zero rather than sent as 0: the schema makes it optional, and
    // "no discount" is the absence of one, not a discount of nothing.
    discountCents = discountCents.takeIf { it != 0L },
    sessionId = sessionId.takeIf { it.isNotBlank() },
)

/** Android's [InvoiceLineItem] as the `createQuote` request's line shape. */
fun InvoiceLineItem.toCreateQuoteLine(): CreateQuoteArgsLineItem = CreateQuoteArgsLineItem(
    description = description,
    qty = qty,
    unitCents = unitCents,
    discountCents = discountCents.takeIf { it != 0L },
    sessionId = sessionId.takeIf { it.isNotBlank() },
)
