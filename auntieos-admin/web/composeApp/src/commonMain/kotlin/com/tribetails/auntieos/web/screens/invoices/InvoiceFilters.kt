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
 * True only when we can prove the invoice is past due: it is outstanding AND its
 * dueDate parses to an ISO date strictly before [todayIso]. A future-dated or
 * unparseable dueDate is never counted as overdue (audit bug: old logic flagged
 * any outstanding invoice that merely had a dueDate, ignoring today).
 *
 * [todayIso] must be a YYYY-MM-DD string (e.g. nowIso().take(10)); lexical
 * comparison on that fixed format is equivalent to chronological comparison.
 */
fun invoiceIsOverdue(invoice: Invoice, todayIso: String): Boolean {
    if (!invoiceIsOutstanding(invoice)) return false
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
