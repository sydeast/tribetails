package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.tribetails.auntieos.ui.admin.ClosureEntry
import com.tribetails.auntieos.ui.admin.closureOccurrencesInRange
import com.tribetails.auntieos.ui.admin.parseClosureEntry
import kotlinx.coroutines.tasks.await
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * The Kotlin twin of `mytribe/functions/src/lib/companyHolidayConflict.ts`,
 * for the SAME ONE Android write path the server guard cannot reach that
 * [BookingBusyConflict.kt] already closes for Google-busy-import conflicts:
 * [BookingRepository.createBooking] writes straight to `enhanced_bookings`,
 * and [KinCareRepository.createKinCareSession] (the `KinCareSession`
 * overload) writes straight to `kin_care_sessions`. Neither goes through a
 * Cloud Function, so `guardCompanyHolidayConflict` (`mytribe/functions`)
 * cannot see either write, and `firestore.rules` has no way to evaluate
 * `companyHolidays`'s recurrence grammar against a sibling document either.
 * This module is that same check, run client-side, immediately before each
 * of those two direct writes -- the same architectural compromise
 * `BookingBusyConflict.kt` already documents and accepts for this pair of
 * call sites, not a new one introduced here.
 *
 * UNLIKE [assertNoBookingBusyConflict], THIS HAS NO OVERRIDE PARAMETER. See
 * `companyHolidayConflict.ts`'s header for the full reasoning: a company
 * holiday is the operator's own deliberate, typed-in closure, not third-party
 * advisory data, so there is no "the operator knows better than their own
 * setting" case to build an escape hatch for.
 *
 * Reuses [ClosureEntry] / [parseClosureEntry] / [closureOccurrencesInRange]
 * from `ClosureRecurrence.kt` (the Android port already shipped for the
 * Settings Time Off editor) rather than a fourth reimplementation of the
 * yearly-recurrence math, and reuses [resolveVisitWindow] /
 * [BusyConflictWindow] from `BookingBusyConflict.kt` (same package) for the
 * wall-clock-to-instant parsing every visit-creating write already needs.
 */

internal class CompanyHolidayConflictException(message: String) : Exception(message)

private const val BUSINESS_SETTINGS_PATH = "business_settings/business_settings"

/** "2026-08-07" for a real instant, UTC. */
private fun utcDateIso(instant: Instant): String =
    DateTimeFormatter.ISO_LOCAL_DATE.withZone(ZoneOffset.UTC).format(instant)

/**
 * The UTC calendar date(s) [window] touches: just the start day for anything
 * under 24h, plus the end day too when the window crosses a UTC midnight.
 * Mirrors the TS `utcDatesForVisit`; see its doc for the same timezone
 * caveat (a closure entry is a bare calendar date with no zone, so this
 * decodes via UTC-by-construction the same way the busy-import guard does).
 */
internal fun utcDatesForVisit(window: BusyConflictWindow): List<String> {
    val startIso = utcDateIso(window.startInstant)
    val endIso = utcDateIso(window.endInstant.minusMillis(1)) // -1ms: a window ending exactly at UTC midnight does not touch the next day.
    return if (startIso == endIso) listOf(startIso) else listOf(startIso, endIso)
}

/** Reads and decodes `business_settings.companyHolidays`. `parseClosureEntry` never throws; a corrupt row decodes to a harmless never-matching entry. */
internal suspend fun loadCompanyHolidayEntries(firestore: FirebaseFirestore): List<ClosureEntry> {
    val snap = firestore.document(BUSINESS_SETTINGS_PATH).get().await()
    @Suppress("UNCHECKED_CAST")
    val raw = snap.get("companyHolidays") as? List<Any?> ?: return emptyList()
    return raw.filterIsInstance<String>().map(::parseClosureEntry)
}

/** The first `(date, holidayName)` any of `dates` lands on, checking every entry, or null when none match. */
internal fun findCompanyHolidayConflict(dates: List<String>, entries: List<ClosureEntry>): Pair<String, String>? {
    for (date in dates) {
        for (entry in entries) {
            if (closureOccurrencesInRange(entry, date, date).isNotEmpty()) {
                return date to entry.name.trim().ifEmpty { "a company holiday" }
            }
        }
    }
    return null
}

/**
 * The one call [BookingRepository.createBooking] and
 * [KinCareRepository.createKinCareSession] each make before their write.
 * Throws [CompanyHolidayConflictException] naming the closed date and holiday
 * when the visit lands on one; returns silently otherwise, including when
 * [startRaw] cannot be parsed at all (same "cannot tell" convention
 * [resolveVisitWindow] already uses for the busy-conflict guard).
 */
internal suspend fun assertNoCompanyHolidayConflict(
    firestore: FirebaseFirestore,
    startRaw: String,
    endRaw: String,
    zone: ZoneId = ZoneId.systemDefault(),
) {
    val window = resolveVisitWindow(startRaw, endRaw, zone) ?: return
    val entries = loadCompanyHolidayEntries(firestore)
    if (entries.isEmpty()) return
    val conflict = findCompanyHolidayConflict(utcDatesForVisit(window), entries) ?: return
    val (date, holidayName) = conflict
    throw CompanyHolidayConflictException(
        "This date is not available: $date falls on $holidayName. The business is closed.",
    )
}
