package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.TimeSlotSource
import kotlinx.coroutines.tasks.await
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/**
 * The Kotlin twin of `mytribe/functions/src/lib/bookingBusyConflict.ts`, for
 * the ONE Android write path server guard cannot reach: a direct Firestore
 * write with no Cloud Function in between.
 *
 * THE DEFECT THIS CLOSES: [BookingRepository.createBooking] writes straight to
 * `enhanced_bookings`, and [KinCareRepository.createKinCareSession] (the
 * `KinCareSession` overload) writes straight to `kin_care_sessions`. Neither
 * goes through a callable, so the server-side guard added alongside this file
 * cannot see either write; rules cannot express an overlap check either
 * (`firestore.rules` only ever gates on auth claims, never on reading a
 * SIBLING document). This module is the same check, run client-side,
 * immediately before each of those two writes.
 *
 * SCOPE: `TimeSlotSource.GOOGLE_BUSY_IMPORT` rows only. `INTERNAL_MANUAL`
 * blocks are the operator's own deliberate schedule block, already surfaced
 * by [BookingRepository.evaluateAvailability] as an advisory warning, and are
 * not what this task closed.
 *
 * PRECISION, DELIBERATELY ABOVE [BookingRepository.evaluateAvailability]'s:
 * that existing check (and the web `bookingAvailability.ts` it mirrors)
 * compares `booking_time_slots.date`/`startTime`/`endTime` as bare wall-clock
 * text with NO timezone conversion, an approximation accepted there because it
 * backs an ADVISORY warning that never blocks a submit. This module is a hard
 * write gate, not a hint, so it earns the cost of doing the conversion for
 * real: `syncGoogleCalendarBusyEvents.ts`'s `busyIntervalToSlot` always
 * derives those three fields from `.toISOString()`, so for a
 * `GOOGLE_BUSY_IMPORT` row, and only that source, they are UTC by
 * construction. A visit's own `startDateTime`/`endDateTime`
 * ([EnhancedBooking]) or `startTime`/`endTime` ([KinCareSession]) is the
 * operator's device wall clock with no zone suffix, so it is anchored to the
 * device's own [ZoneId] before comparing. One caveat inherited from the
 * schema, not introduced here: a slot carries a single `date` for the whole
 * block, so a `GOOGLE_BUSY_IMPORT` row spanning more than 24h decodes short.
 */

private val DAY: Duration = Duration.ofDays(1)
private val DATE_RE = Regex("""^\d{4}-\d{2}-\d{2}$""")
private val TIME_RE = Regex("""^\d{2}:\d{2}$""")

/** Cap mirroring the TS loader's `MAX_BUSY_SLOTS`; see that file for the reasoning. */
private const val MAX_BUSY_SLOTS = 500L

/** A resolved, checkable visit window in real instants. */
internal data class BusyConflictWindow(val startInstant: Instant, val endInstant: Instant)

/** A single `GOOGLE_BUSY_IMPORT` `booking_time_slots` row, decoded to real UTC instants. */
internal data class DecodedBusySlot(
    val docId: String,
    val startInstant: Instant,
    val endInstant: Instant,
    /** "2026-08-07 22:00 UTC to 2026-08-08 02:00 UTC", for the fail-loud message. */
    val label: String,
)

/** Thrown by [assertNoBookingBusyConflict]; its message is what the ViewModel surfaces to the operator. */
internal class BookingBusyConflictException(message: String) : Exception(message)

private fun formatUtc(instant: Instant): String =
    DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneOffset.UTC).format(instant) + " UTC"

/**
 * Parses a visit's own start/end field to a real instant. Accepts a genuine
 * zoned/UTC instant string (`Instant.parse`, e.g. anything ending `Z`) first;
 * falls back to a bare `ISO_LOCAL_DATE_TIME` (no zone) anchored to [zone],
 * which is the shape [EnhancedBooking.startDateTime] /
 * [KinCareSession.startTime] actually carry today (the device's own wall
 * clock at the moment it was picked; see `NewBookingRequestDialog.kt` and
 * `bookingAvailability.ts`'s header for the cross-client confirmation of that
 * contract). Returns null, never throws, for anything neither shape parses:
 * this task is not the place to newly enforce a stricter format on a field
 * that has never validated one.
 */
internal fun parseVisitInstant(raw: String, zone: ZoneId = ZoneId.systemDefault()): Instant? {
    if (raw.isBlank()) return null
    return try {
        Instant.parse(raw)
    } catch (_: DateTimeParseException) {
        try {
            LocalDateTime.parse(raw, DateTimeFormatter.ISO_LOCAL_DATE_TIME).atZone(zone).toInstant()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}

/**
 * Resolves a visit's raw start/end strings to a checkable window, or null when
 * the start cannot be parsed at all (treated as "cannot tell", not "block").
 * A missing/unparseable end is NOT the same as a missing start: it is expanded
 * to a one-millisecond point at the start instant, so a visit with only a
 * known start is still checked for landing inside a busy window.
 */
internal fun resolveVisitWindow(
    startRaw: String,
    endRaw: String,
    zone: ZoneId = ZoneId.systemDefault(),
): BusyConflictWindow? {
    val start = parseVisitInstant(startRaw, zone) ?: return null
    val parsedEnd = endRaw.takeIf { it.isNotBlank() }?.let { parseVisitInstant(it, zone) }
    val end = if (parsedEnd != null && parsedEnd.isAfter(start)) parsedEnd else start.plusMillis(1)
    return BusyConflictWindow(start, end)
}

/**
 * Decodes ONE `booking_time_slots` row into real UTC instants, or null when it
 * is not a `GOOGLE_BUSY_IMPORT` row, or its `date`/`startTime`/`endTime` do not
 * parse as the documented shapes. Rolls the end to the next UTC day when
 * `endTime <= startTime`, so a block spanning UTC midnight decodes to the real
 * window rather than a negative or zero-length one.
 */
internal fun decodeGoogleBusySlot(slot: BookingTimeSlot): DecodedBusySlot? {
    if (slot.source != TimeSlotSource.GOOGLE_BUSY_IMPORT) return null
    if (!DATE_RE.matches(slot.date) || !TIME_RE.matches(slot.startTime) || !TIME_RE.matches(slot.endTime)) return null
    val startInstant = runCatching { Instant.parse("${slot.date}T${slot.startTime}:00Z") }.getOrNull() ?: return null
    val sameDayEnd = runCatching { Instant.parse("${slot.date}T${slot.endTime}:00Z") }.getOrNull() ?: return null
    val endInstant = if (slot.endTime <= slot.startTime) sameDayEnd.plus(DAY) else sameDayEnd
    if (!endInstant.isAfter(startInstant)) return null
    return DecodedBusySlot(slot.id, startInstant, endInstant, "${formatUtc(startInstant)} to ${formatUtc(endInstant)}")
}

/**
 * Pure overlap check: half-open instants `[startInstant, endInstant)`, so a
 * visit ending exactly when a busy block starts (or starting exactly when one
 * ends) is NOT a conflict, and a visit starting exactly when a busy block
 * starts IS.
 */
internal fun findBusyConflicts(visit: BusyConflictWindow, slots: List<DecodedBusySlot>): List<DecodedBusySlot> =
    slots.filter { visit.startInstant.isBefore(it.endInstant) && visit.endInstant.isAfter(it.startInstant) }

/** UTC `YYYY-MM-DD` range covering [window], padded a day on each side. See the TS twin for why the pad exists. */
internal fun utcDateRangeFor(window: BusyConflictWindow): Pair<String, String> {
    val fmt = DateTimeFormatter.ISO_LOCAL_DATE.withZone(ZoneOffset.UTC)
    return fmt.format(window.startInstant.minus(DAY)) to fmt.format(window.endInstant.plus(DAY))
}

/**
 * Loads the `GOOGLE_BUSY_IMPORT` rows that could possibly overlap [window].
 * Deliberately ONE filter in the query (`date` range), same reasoning as the
 * TS loader: a `source` equality alongside a `date` range needs a composite
 * index, and this collection is read elsewhere
 * ([BookingRepository.getUnavailableSlotsForDate]) without one. `source` is
 * filtered in [decodeGoogleBusySlot] instead.
 */
internal suspend fun loadGoogleBusySlots(firestore: FirebaseFirestore, window: BusyConflictWindow): List<BookingTimeSlot> {
    val (fromDate, toDate) = utcDateRangeFor(window)
    val snapshot = firestore.collection("booking_time_slots")
        .whereGreaterThanOrEqualTo("date", fromDate)
        .whereLessThanOrEqualTo("date", toDate)
        .limit(MAX_BUSY_SLOTS)
        .get()
        .await()
    return snapshot.toObjects(BookingTimeSlot::class.java)
}

/**
 * The one call [BookingRepository.createBooking] and
 * [KinCareRepository.createKinCareSession] each make before their write.
 * Throws [BookingBusyConflictException] naming the conflicting window(s) when
 * the visit lands on a Google Calendar busy import; returns silently
 * otherwise, including when [startRaw] cannot be parsed at all (see
 * [resolveVisitWindow]).
 */
internal suspend fun assertNoBookingBusyConflict(
    firestore: FirebaseFirestore,
    startRaw: String,
    endRaw: String,
    zone: ZoneId = ZoneId.systemDefault(),
) {
    val window = resolveVisitWindow(startRaw, endRaw, zone) ?: return
    val rawSlots = loadGoogleBusySlots(firestore, window)
    val decoded = rawSlots.mapNotNull(::decodeGoogleBusySlot)
    val conflicts = findBusyConflicts(window, decoded)
    if (conflicts.isEmpty()) return
    val windows = conflicts.joinToString("; ") { it.label }
    throw BookingBusyConflictException(
        "This time is not available: conflicts with a Google Calendar busy block ($windows).",
    )
}
