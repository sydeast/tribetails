package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice

/**
 * Pure helpers for invoice classification, shared by the list screen and detail
 * screen so the two never disagree on whether an invoice is paid, outstanding,
 * or overdue (audit bug: list and detail used two different paid-tests).
 *
 * Invoice.status is free-text in the source of truth, so paid-vs-outstanding is
 * decided by amountDue (the money owed), and the free-text status only contributes
 * an explicit "paid" / "draft" hint. We never claim a state we cannot prove.
 */

/** True when the free-text status is an explicit paid marker (any casing). */
private fun statusSaysPaid(invoice: Invoice): Boolean =
    invoice.status.trim().lowercase() == "paid"

/** True when the free-text status is an explicit draft marker (any casing). */
fun invoiceIsDraft(invoice: Invoice): Boolean =
    invoice.status.trim().lowercase() == "draft"

/**
 * Stage 2 Step 4: a quote is an invoice in QUOTE status. createQuote stamps both
 * `status = "QUOTE"` (admin field) and `invoiceStatus = "quote"` (portal field);
 * Invoice only carries `status`, so we classify off that, case-insensitively.
 * When accepted, the status changes to a normal invoice state (typically "open").
 * When denied, the status deliberately remains "quote" with a decision record
 * (acceptQuote / denyQuote); a declined quote is not the same as an unanswered one
 * but cannot be distinguished by this function alone. Pure; unit-tested.
 */
fun invoiceIsQuote(invoice: Invoice): Boolean =
    invoice.status.trim().lowercase() == "quote"

/**
 * Canonical "this invoice still owes money" test. An invoice is outstanding when
 * a positive balance remains AND it is not explicitly marked paid. This is the
 * single source of truth consumed by both the list and the detail screen.
 */
fun invoiceIsOutstanding(invoice: Invoice): Boolean =
    !statusSaysPaid(invoice) && invoice.amountDue > 0.0

/** Canonical paid test: the logical negation of outstanding (and not a draft). */
fun invoiceIsPaid(invoice: Invoice): Boolean =
    !invoiceIsDraft(invoice) && !invoiceIsOutstanding(invoice)

/**
 * Normalizes a stored date string to a comparable YYYY-MM-DD prefix, or null
 * when the string is blank or not in an ISO-like form. Dates are raw free-text
 * in Firestore (no parsed Date), so we only trust a leading 10-char ISO date
 * (e.g. "2026-05-21" or "2026-05-21T..."). Anything else returns null so we
 * never fabricate an ordering or an overdue verdict from unparseable text.
 */
fun isoDatePrefixOrNull(raw: String): String? {
    val s = raw.trim()
    if (s.length < 10) return null
    val candidate = s.substring(0, 10)
    // YYYY-MM-DD shape check: digits and dashes in the right slots.
    if (candidate[4] != '-' || candidate[7] != '-') return null
    val digitsOk = candidate.withIndex().all { (i, ch) ->
        if (i == 4 || i == 7) ch == '-' else ch.isDigit()
    }
    return if (digitsOk) candidate else null
}

/**
 * The eight states the server's state stamp writes into `status` (ADR-0002,
 * `lib/invoiceEditPolicy.ts#INVOICE_STATES`). The same vocabulary as Android's
 * `domain/InvoiceActions.kt#InvoiceState` and the web's `InvoiceState`.
 */
enum class InvoiceState { QUOTE, DRAFT, CANCELLED, CREDIT, REDEEMED, PAID, ZERO, OPEN }

/**
 * Decodes the stored state stamp, or null when the doc carries none this build
 * recognises. A DECODE, NOT A CLASSIFICATION: only `status` is read, trimmed and
 * lowercased, exactly as Android's `invoiceStateOrNull`. No money field is
 * consulted; the server did that in the write that moved the money.
 */
fun invoiceStateOrNull(invoice: Invoice): InvoiceState? = when (invoice.status.trim().lowercase()) {
    "quote" -> InvoiceState.QUOTE
    "draft" -> InvoiceState.DRAFT
    "cancelled" -> InvoiceState.CANCELLED
    "credit" -> InvoiceState.CREDIT
    "redeemed" -> InvoiceState.REDEEMED
    "paid" -> InvoiceState.PAID
    "zero" -> InvoiceState.ZERO
    "open" -> InvoiceState.OPEN
    else -> null
}

/**
 * #871: whether the operator may be offered "Send reminder". Only a stored
 * `open` bill, the same rule the server's `sendInvoiceReminder` enforces and the
 * web and Android `invoiceActionsFor` already follow. A cancelled invoice, a
 * draft, a credit or a quote with a balance on it used to be offered the button
 * here because this screen read `amountDue` instead of the state.
 */
fun invoiceIsRemindable(invoice: Invoice): Boolean =
    invoiceStateOrNull(invoice) == InvoiceState.OPEN

/**
 * True only when the STORED state is `open` AND the dueDate parses to an ISO
 * date strictly before [todayIso]. Due today is due, not overdue. A future-dated
 * or unparseable dueDate is never counted as overdue.
 *
 * #871: this read `amountDue > 0` before, so a cancelled invoice, a draft, a
 * credit or a quote with a balance and a past date showed OVERDUE on this
 * console while the server never chases them and web and Android never call
 * them overdue. It now reads the stamp, as they do: the server's overdue notice
 * goes out for exactly the invoices this marks.
 *
 * [todayIso] must be a YYYY-MM-DD string (e.g. nowIso().take(10)); lexical
 * comparison on that fixed format is equivalent to chronological comparison.
 */
fun invoiceIsOverdue(invoice: Invoice, todayIso: String): Boolean {
    if (invoiceStateOrNull(invoice) != InvoiceState.OPEN) return false
    val due = isoDatePrefixOrNull(invoice.dueDate) ?: return false
    return due < todayIso
}

/**
 * Whole days the invoice is past due, or null when not overdue / unparseable.
 * Uses a simple proleptic-Gregorian day count so we avoid any java.time/Date
 * dependency that is unavailable on Wasm.
 */
fun daysOverdue(invoice: Invoice, todayIso: String): Int? {
    if (!invoiceIsOverdue(invoice, todayIso)) return null
    val due = isoDatePrefixOrNull(invoice.dueDate) ?: return null
    val dueDays = isoToEpochDay(due) ?: return null
    val todayDays = isoToEpochDay(todayIso) ?: return null
    val diff = todayDays - dueDays
    return if (diff > 0) diff.toInt() else null
}

/** Converts a YYYY-MM-DD string to a day index, or null if out of range. */
private fun isoToEpochDay(iso: String): Long? {
    val y = iso.substring(0, 4).toIntOrNull() ?: return null
    val m = iso.substring(5, 7).toIntOrNull() ?: return null
    val d = iso.substring(8, 10).toIntOrNull() ?: return null
    if (m !in 1..12 || d !in 1..31) return null
    // Howard Hinnant's days-from-civil algorithm.
    val yAdj = if (m <= 2) y - 1 else y
    val era = (if (yAdj >= 0) yAdj else yAdj - 399) / 400
    val yoe = yAdj - era * 400
    val mp = (m + 9) % 12
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era.toLong() * 146097 + doe.toLong() - 719468
}

/**
 * Humanizes an ISO date prefix to a compact "May 21" label for row meta lines,
 * or echoes the raw string when it is not ISO-parseable (fail-loud: we show the
 * operator exactly what is stored rather than hiding bad data).
 */
fun humanizeDate(raw: String): String {
    val iso = isoDatePrefixOrNull(raw) ?: return raw.trim()
    val month = iso.substring(5, 7).toIntOrNull() ?: return raw.trim()
    val day = iso.substring(8, 10).toIntOrNull() ?: return raw.trim()
    val name = when (month) {
        1 -> "Jan"; 2 -> "Feb"; 3 -> "Mar"; 4 -> "Apr"; 5 -> "May"; 6 -> "Jun"
        7 -> "Jul"; 8 -> "Aug"; 9 -> "Sep"; 10 -> "Oct"; 11 -> "Nov"; 12 -> "Dec"
        else -> return raw.trim()
    }
    return "$name $day"
}

fun formatMoney(amount: Double): String {
    // Two-decimal formatting without java.text (avoids stdlib gaps on Wasm).
    val abs     = if (amount < 0) -amount else amount
    val cents   = ((abs * 100) + 0.5).toLong()
    val whole   = cents / 100
    val frac    = cents % 100
    val fracStr = if (frac < 10) "0$frac" else "$frac"
    val sign    = if (amount < 0) "-" else ""
    return "$sign\$$whole.$fracStr"
}

/**
 * Den filter tabs. The same seven tabs, labels and order as the admin web
 * (`FILTERS` in src/screens/Invoices.tsx) and Android.
 */
enum class InvoiceFilter(val label: String) {
    All("All"),
    Open("Open"),
    Overdue("Overdue"),
    Paid("Paid"),
    Draft("Draft"),
    Quote("Quote"),
    Credit("Credit"),
}
/**
 * Tab membership, each a POSITIVE test against the STORED state stamp (or the
 * derived overdue flag), exactly as web's `FILTERS`. An unstamped doc matches
 * only All. Credit also takes `redeemed`. These do not use [invoiceIsOutstanding]
 * or [invoiceIsPaid], which read `amountDue` and stay for the detail screen.
 */
fun invoiceMatchesFilter(invoice: Invoice, filter: InvoiceFilter, todayIso: String): Boolean {
    val state = invoiceStateOrNull(invoice)
    return when (filter) {
        InvoiceFilter.All -> true
        InvoiceFilter.Open -> state == InvoiceState.OPEN
        InvoiceFilter.Overdue -> invoiceIsOverdue(invoice, todayIso)
        InvoiceFilter.Paid -> state == InvoiceState.PAID
        InvoiceFilter.Draft -> state == InvoiceState.DRAFT
        InvoiceFilter.Quote -> state == InvoiceState.QUOTE
        InvoiceFilter.Credit -> state == InvoiceState.CREDIT || state == InvoiceState.REDEEMED
    }
}

/**
 * Row chip label, driven by the stored state stamp exactly as Android's row and
 * web's `invoiceStateInfo` do: Overdue first, then the stamp's own name, and the
 * raw stored string for an unstamped doc. Never derived from amountDue, so a
 * credit, a cancelled invoice or a zero-balance open bill is not called Paid.
 * (The desktop Invoice carries no quote decision, so a declined quote reads Quote.)
 */
fun invoiceChipLabel(invoice: Invoice, todayIso: String): String {
    if (invoiceIsOverdue(invoice, todayIso)) return "Overdue"
    return when (invoiceStateOrNull(invoice)) {
        InvoiceState.QUOTE -> "Quote"
        InvoiceState.DRAFT -> "Draft"
        InvoiceState.CANCELLED -> "Cancelled"
        InvoiceState.CREDIT -> "Credit"
        InvoiceState.REDEEMED -> "Redeemed"
        InvoiceState.ZERO -> "Zero"
        InvoiceState.OPEN -> "Open"
        InvoiceState.PAID -> "Paid"
        null -> invoice.status.trim().ifBlank { "No status" }
    }
}
