package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.repository.NewBookingVisit
import com.tribetails.auntieos.ui.admin.ClosureEntry
import com.tribetails.auntieos.ui.admin.closureOccurrencesInRange
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * D1: what the wizard's Dates step knows about a day before the operator picks
 * it. Pure, so every badge and every warning is unit-testable.
 *
 * THREE SIGNALS, THREE DIFFERENT WEIGHTS, and the difference is not cosmetic:
 *
 *  - CLOSED (a `business_settings.companyHolidays` entry). A hard refusal.
 *    `guardCompanyHolidayConflict` (PR #204) refuses these server-side on every
 *    booking write path with NO override parameter, so a wizard that let the
 *    operator pick one would be offering a submit that cannot succeed. The day
 *    is unpickable and [BookingWizardStep.DATES] will not advance past one.
 *  - BLOCKED (a `GOOGLE_BUSY_IMPORT` row in `booking_time_slots`). A warning.
 *    The server refuses it too, but `overrideBusyConflict` exists precisely so
 *    an operator can knowingly go past it ("the operator is the business"), so
 *    this reads as a warning and the refusal offers a "Create anyway" retry.
 *  - OUTSIDE HOURS (`business_hours`). A warning only. Nothing refuses it.
 *
 * WARNINGS ARE COMPUTED PER CONCRETE VISIT, not as a day-by-time cross product.
 * The web wizard collects all selected days and all distinct times and calls
 * `selectionWarnings(allDays, time)` once per time, so an operator with Aug 23 at
 * 10:00 and Aug 24 at 19:00 is told "Aug 23: 19:00 is outside business hours" for
 * a visit that does not exist. Here each [NewBookingVisit] carries its own
 * instant, so a warning names a real visit or it is not emitted.
 */

/** How a day reads on the calendar grid. Order is refusal-first. */
enum class BookingDayBadge { NONE, PAST, CLOSED, BLOCKED }

/** Everything the Dates step needs about one calendar day. */
data class BookingDayAvailability(
    val date: LocalDate,
    val badge: BookingDayBadge,
    /** The company-holiday name when [badge] is CLOSED, else null. */
    val closedFor: String? = null,
    /** "8:00 AM to 12:00 PM" windows imported as busy, empty when none. */
    val blockedWindows: List<String> = emptyList(),
) {
    /** A closed or past day cannot be picked at all. Blocked days still can be. */
    val pickable: Boolean get() = badge != BookingDayBadge.CLOSED && badge != BookingDayBadge.PAST

    /** The full accessible description, e.g. "Aug 23, closed for Founders Day, not available". */
    val description: String
        get() = buildString {
            append(formatShortDate(date))
            when (badge) {
                BookingDayBadge.PAST -> append(", in the past, not available")
                BookingDayBadge.CLOSED -> append(", closed for ${closedFor ?: "a company holiday"}, not available")
                BookingDayBadge.BLOCKED -> append(", blocked time at ${blockedWindows.joinToString(", ")}")
                BookingDayBadge.NONE -> Unit
            }
        }
}

/**
 * The reference data the Dates step reasons over, already decoded. Built once
 * from `SchedulingState` and handed down, so no composable does Firestore work.
 *
 * Every field defaults empty on purpose: a failed read must degrade to "nothing
 * is known about availability", never to "everything is available and refusals
 * are a surprise". The Dates step surfaces [unknown] as a banner when that
 * happens rather than silently pretending.
 */
data class BookingAvailability(
    /** Decoded `business_settings.companyHolidays` entries. */
    val closures: List<ClosureEntry> = emptyList(),
    /** `booking_time_slots` blocked rows, grouped by their local `YYYY-MM-DD`. */
    val blockedByDate: Map<String, List<BookingTimeSlot>> = emptyMap(),
    /** The `business_hours` rows, `dayOfWeek` 1 = Monday .. 7 = Sunday. */
    val businessHours: List<BusinessHours> = emptyList(),
    /** Non-null when a read failed, so the step can say so instead of guessing. */
    val unknown: String? = null,
) {
    /**
     * The company-holiday name closing [date], or null. Suitable as the
     * `closedDayName` argument to [stepBlocker].
     *
     * A blank stored name still closes the day; it just reads as the generic
     * "a company holiday", the same fallback the server and web both use.
     */
    fun closedDayName(date: LocalDate): String? {
        val iso = date.toString()
        val hit = closures.firstOrNull { closureOccurrencesInRange(it, iso, iso).isNotEmpty() }
            ?: return null
        return hit.name.trim().ifEmpty { "a company holiday" }
    }

    /** The imported busy windows on [date], formatted for display. */
    fun blockedWindows(date: LocalDate): List<String> =
        blockedByDate[date.toString()].orEmpty().map { formatWindow(it.startTime, it.endTime) }

    /** The day's opening row, or null when `business_hours` says nothing about it. */
    fun hoursFor(date: LocalDate): BusinessHours? =
        businessHours.firstOrNull { it.dayOfWeek == date.dayOfWeek.value }

    /** How [date] reads on the grid. */
    fun dayAvailability(date: LocalDate, today: LocalDate = LocalDate.now()): BookingDayAvailability {
        val closed = closedDayName(date)
        val blocked = blockedWindows(date)
        val badge = when {
            date.isBefore(today) -> BookingDayBadge.PAST
            closed != null -> BookingDayBadge.CLOSED
            blocked.isNotEmpty() -> BookingDayBadge.BLOCKED
            else -> BookingDayBadge.NONE
        }
        return BookingDayAvailability(date, badge, closed, blocked)
    }
}

/** How many warnings the Dates step lists before collapsing the rest into a count. */
private const val MAX_LISTED_WARNINGS = 6

/**
 * One line per real problem with a real visit, deduped and capped. Empty when
 * every visit sits inside open hours and clear of every imported busy block.
 *
 * Closures are NOT in here: they are a hard gate in [stepBlocker], so a state
 * that reaches this function has none left to warn about.
 */
fun bookingSelectionWarnings(
    visits: List<NewBookingVisit>,
    availability: BookingAvailability,
    zone: ZoneId = ZoneId.systemDefault(),
): List<String> {
    val lines = LinkedHashSet<String>()
    visits.forEach { visit ->
        val at = Instant.ofEpochMilli(visit.startTimeMs).atZone(zone)
        val date = at.toLocalDate()
        val minutes = at.hour * 60 + at.minute
        val dayLabel = formatShortDate(date)
        val timeLabel = formatClock(at.hour, at.minute)

        availability.blockedByDate[date.toString()].orEmpty().forEach { slot ->
            val start = hhmmToMinutes(slot.startTime)
            val end = hhmmToMinutes(slot.endTime)
            // An unparseable window cannot say whether it contains this visit, so
            // it stays silent rather than fabricating a clash.
            if (start != null && end != null && minutes >= start && minutes < end) {
                lines += "$dayLabel at $timeLabel: blocked time from ${formatWindow(slot.startTime, slot.endTime)}."
            }
        }

        val hours = availability.hoursFor(date)
        if (hours != null) {
            if (!hours.isOpen) {
                lines += "$dayLabel: the business is closed that day."
            } else {
                val open = hhmmToMinutes(hours.openTime)
                val close = hhmmToMinutes(hours.closeTime)
                if (open != null && close != null && (minutes < open || minutes >= close)) {
                    lines += "$dayLabel at $timeLabel: outside business hours " +
                        "(${formatWindow(hours.openTime, hours.closeTime)})."
                }
            }
        }
    }
    val all = lines.toList()
    if (all.size <= MAX_LISTED_WARNINGS) return all
    val hidden = all.size - MAX_LISTED_WARNINGS
    return all.take(MAX_LISTED_WARNINGS) + "and $hidden more."
}

private val MONTHS = listOf(
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)

/** "Aug 23". Hand-rolled rather than DateTimeFormatter so it is locale-stable in tests. */
fun formatShortDate(date: LocalDate): String = "${MONTHS[date.monthValue - 1]} ${date.dayOfMonth}"

/** "Mon, Aug 23". */
fun formatDayAndDate(date: LocalDate): String {
    val day = date.dayOfWeek.name.lowercase().replaceFirstChar { it.uppercase() }.take(3)
    return "$day, ${formatShortDate(date)}"
}

/** 24h wall clock to "9:00 AM". */
fun formatClock(hour: Int, minute: Int): String {
    val suffix = if (hour < 12) "AM" else "PM"
    val h = when {
        hour % 12 == 0 -> 12
        else -> hour % 12
    }
    return "$h:%02d %s".format(minute, suffix)
}

/**
 * "8:00 AM to 12:00 PM" from two "HH:mm" strings. Falls back to the raw strings
 * when either is unparseable, so a malformed slot still says something true
 * rather than a fabricated time.
 */
fun formatWindow(startHHmm: String, endHHmm: String): String {
    val start = hhmmToMinutes(startHHmm)
    val end = hhmmToMinutes(endHHmm)
    if (start == null || end == null) {
        return listOf(startHHmm, endHHmm).filter { it.isNotBlank() }.joinToString(" to ")
    }
    return "${formatClock(start / 60, start % 60)} to ${formatClock(end / 60, end % 60)}"
}
