package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession

/**
 * Pure joins backing the kinfolk-profile feed panels (Recent KinTales / Upcoming
 * visits / Invoices). Extracted from the composable so the filter+sort logic is
 * unit-tested rather than inline. Replaces the former "NOT WIRED" placeholders.
 *
 * All time compares are lexical on ISO-8601 strings, the date convention used
 * across the web client (see invoiceIsOverdue, etc.). Mixed precisions
 * ("2026-06-04" vs "2026-06-04T10:00:00Z") still order correctly because the
 * shared date prefix dominates the comparison.
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
        .filter { it.status.equals("SCHEDULED", ignoreCase = true) || it.status.equals("CONFIRMED", ignoreCase = true) }
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
        .sortedByDescending { it.sentAt.ifBlank { it.visitDate } }
        .take(limit)
        .toList()

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
