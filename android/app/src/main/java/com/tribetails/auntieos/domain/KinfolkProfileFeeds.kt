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
