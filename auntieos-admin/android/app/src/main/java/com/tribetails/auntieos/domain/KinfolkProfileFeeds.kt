package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession

/**
 * Android mirror of web `screens/directory/KinfolkProfileFeeds.kt`. Pure joins for
 * the kinfolk-profile feed cards (Recent KinTales / Upcoming visits / Invoices).
 * Lexical ISO-8601 compares (the app's date convention). Kept in lockstep with web
 * by KinfolkProfileFeedsTest on each platform.
 */

/** SCHEDULED/CONFIRMED visits for [kinfolkId] dated at/after [nowIso], soonest first. */
fun upcomingVisitsFor(
    sessions: List<KinCareSession>,
    kinfolkId: String,
    nowIso: String,
    limit: Int = 5,
): List<KinCareSession> =
    sessions.asSequence()
        .filter { it.kinfolkId == kinfolkId }
        .filter { it.status.equals("scheduled", ignoreCase = true) || it.status.equals("confirmed", ignoreCase = true) }
        .filter { it.startTime.isNotBlank() && it.startTime >= nowIso }
        .sortedBy { it.startTime }
        .take(limit)
        .toList()

/** SENT KinTales for [kinfolkId], most recent first (sentAt, falling back to visitDate). */
fun recentTalesFor(
    reports: List<KinCareReport>,
    kinfolkId: String,
    limit: Int = 5,
): List<KinCareReport> =
    reports.asSequence()
        .filter { it.kinfolkId == kinfolkId }
        .filter { it.status.equals("SENT", ignoreCase = true) }
        .sortedByDescending { it.sentAt.orEmpty().ifBlank { it.visitDate } }
        .take(limit)
        .toList()

/**
 * The left-hand line of one row in the profile's INVOICES card: the invoice
 * number, and the date it carries when it carries one.
 *
 * Lifted out of the composable so the string is unit-testable, which is the
 * whole reason it is here: this expression used to end in `inv.date.take(10)`.
 * See [freeTextDateLabel] for why ten characters of `invoices.date` is a
 * different date rather than a shorter one.
 *
 * A blank date drops the whole ` · ` segment, as it always has, so the row is
 * the invoice number alone rather than a number trailing a separator into
 * nothing.
 */
fun kinfolkInvoiceFeedLabel(invoice: Invoice): String {
    val number = invoice.invoiceNumber.ifBlank { "Invoice" }
    val date = freeTextDateLabel(invoice.date)
    return if (date.isEmpty()) number else "$number · $date"
}

/** Invoices for [kinfolkId], most recent first. */
fun invoicesForKinfolk(
    invoices: List<Invoice>,
    kinfolkId: String,
    limit: Int = 5,
): List<Invoice> =
    invoices.asSequence()
        .filter { it.kinfolkId == kinfolkId }
        .sortedByDescending { it.date }
        .take(limit)
        .toList()
