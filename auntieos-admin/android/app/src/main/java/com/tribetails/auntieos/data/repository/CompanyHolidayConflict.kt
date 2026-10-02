package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.tribetails.auntieos.ui.admin.ClosureEntry
import com.tribetails.auntieos.ui.admin.closureOccurrencesInRange
import com.tribetails.auntieos.ui.admin.parseClosureEntry
import kotlinx.coroutines.tasks.await
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

/**
 * The zone a business's calendar dates are read in: `business_settings.timeZone`,
 * or UTC when it is blank or not a zone this phone can read. This is the ONE
 * place the fallback lives, and it is the server's rule today
 * (`businessCalendarDate` in `bookingTimeBlocks.ts` falls back to the UTC date
 * for an unusable zone). #1109 is unifying that default; change it here.
 */
internal fun businessZoneOrUtc(timeZone: String): ZoneId =
    timeZone.trim().takeIf { it.isNotEmpty() }?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: ZoneOffset.UTC
/**
 * The business calendar date(s) [window] covers in [timeZone]: the start's date
 * through the date its last millisecond is on, counted by calendar (never by
 * adding 24h of instants), so a daylight-saving day is neither skipped nor
 * doubled. A window ending exactly at midnight does not touch the next day.
 * Mirrors the TS `businessDatesForVisit` (#1093); a blank or unusable
 * [timeZone] falls back per [businessZoneOrUtc].
 */
internal fun businessDatesForVisit(window: BusyConflictWindow, timeZone: String): List<String> {
    val zone = businessZoneOrUtc(timeZone)
    val start = window.startInstant
    val end = if (window.endInstant.isAfter(start)) window.endInstant else start.plusMillis(1)
    val first = start.atZone(zone).toLocalDate()
    val last = end.minusMillis(1).atZone(zone).toLocalDate() // -1ms: a window ending exactly at midnight does not touch the next day.
    val out = mutableListOf<String>()
    var d = first
    while (!d.isAfter(last)) {
        out += d.format(DateTimeFormatter.ISO_LOCAL_DATE)
        d = d.plusDays(1)
    }
    return out
}
/** `business_settings.companyHolidays` decoded, plus the zone their dates are in. */
internal data class CompanyHolidaySettings(val entries: List<ClosureEntry>, val timeZone: String)
/** Reads and decodes `business_settings.companyHolidays` and `timeZone` in one read. `parseClosureEntry` never throws; a corrupt row decodes to a harmless never-matching entry. */
internal suspend fun loadCompanyHolidaySettings(firestore: FirebaseFirestore): CompanyHolidaySettings {
    val snap = firestore.document(BUSINESS_SETTINGS_PATH).get().await()
    @Suppress("UNCHECKED_CAST")
    val raw = snap.get("companyHolidays") as? List<Any?> ?: emptyList()
    val entries = raw.filterIsInstance<String>().map(::parseClosureEntry)
    return CompanyHolidaySettings(entries, (snap.get("timeZone") as? String).orEmpty().trim())
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
) {
    val (entries, timeZone) = loadCompanyHolidaySettings(firestore)
    if (entries.isEmpty()) return
    // A bare wall-clock start is the business's own clock, so it is anchored to the business zone, not this phone's.
    val window = resolveVisitWindow(startRaw, endRaw, businessZoneOrUtc(timeZone)) ?: return
    val conflict = findCompanyHolidayConflict(businessDatesForVisit(window, timeZone), entries) ?: return
    val (date, holidayName) = conflict
    throw CompanyHolidayConflictException(
        "This date is not available: $date falls on $holidayName. The business is closed.",
    )
}
