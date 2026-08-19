package com.kinfolk.portal.util

import kotlinx.datetime.LocalDate

/**
 * The day an invoice line covers, as a household reads it.
 *
 * WHY THIS EXISTS NOW. Invoice lines drawn from a visit carry that visit's
 * `startTime`, an ISO-8601 string, and the detail screen printed it verbatim:
 * a household looking at what they were billed for saw
 * `2026-07-10T14:00:00.000Z`. Until issue #408 only legacy invoices with no
 * stored lines ever reached that branch, so it was rare enough to be missed.
 * Every invoice built from work carries dated lines now.
 *
 * MIRRORS `longDateLabel` IN `mytribe/web/src/lib/invoiceFormat.ts`, so the
 * same line reads the same on both portals: "Jul 10, 2026".
 *
 * THE DAY IS TAKEN AS WRITTEN, not converted into the reader's time zone. The
 * value names the DAY work happened, and a visit at 8pm Pacific is not the next
 * day because the household opened the invoice while travelling. `weekdayTime`
 * in `RelativeTime.kt` answers the other question, for a moment rather than a
 * day, and does convert.
 *
 * AN UNREADABLE VALUE IS RETURNED AS ITSELF, never blanked and never replaced
 * with today. This collection has held free text in its date fields for years
 * (see the money/format note in CALLABLE_CONTRACT.md), and showing the
 * household what is actually stored beats hiding it or inventing a date.
 */
private val MONTH_ABBREV =
    listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

fun invoiceDayLabel(raw: String?): String {
    val text = raw?.trim().orEmpty()
    if (text.isEmpty()) return ""
    // The date half of an ISO-8601 value, which is all a day label needs. A
    // bare `YYYY-MM-DD` is the same string.
    val day = text.take(10)
    val date = runCatching { LocalDate.parse(day) }.getOrNull() ?: return text
    return "${MONTH_ABBREV[date.month.ordinal]} ${date.day.toString().padStart(2, '0')}, ${date.year}"
}

/**
 * "3 x $20.00" for a line billed more than once, or "" when the breakdown adds
 * nothing.
 *
 * A QUANTITY OF ONE IS NOT SHOWN, because it only repeats the amount beside it.
 * A line billed 3 x $20 that reads as a bare $60 is the case this exists for:
 * the household cannot check a total they were shown no working for. Mirrors
 * the same rule in `mytribe/web/src/screens/InvoiceDetail.tsx`.
 */
fun invoiceLineUnits(qty: Double?, unitCents: Long?): String {
    if (qty == null || unitCents == null) return ""
    if (qty == 1.0) return ""
    val qtyLabel = if (qty % 1.0 == 0.0) qty.toLong().toString() else qty.toString()
    return "$qtyLabel x ${formatUsd(unitCents.toDouble() / 100.0)}"
}
