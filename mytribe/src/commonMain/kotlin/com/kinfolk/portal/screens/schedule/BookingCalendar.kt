package com.kinfolk.portal.screens.schedule

import kotlinx.datetime.LocalDate

/**
 * Pure month/horizon math for the booking wizard's Individual-date picker.
 *
 * Ported in lockstep with `mytribe/web/src/lib/bookingWizardLogic.ts` so the
 * portal's two clients offer the same set of dates from the same inputs —
 * same bounds, same real calendar months, same inclusive endpoints. Kept
 * free of Compose so it is unit-testable (BookingCalendarTest.kt).
 *
 * #544: this file exists because the picker used to be frozen on the current
 * month with no control to leave it, so a household could not book ahead at
 * all — late in a month there were a handful of bookable days left in the
 * entire portal.
 */

/**
 * How far ahead a household may book.
 *
 * There is NO booking-horizon field on the `business_settings` doc (it
 * carries hours, holidays, time blocks, travel buffer, ETA and retention
 * windows, and nothing horizon-shaped), so rather than invent an operator
 * setting nobody can see or edit, the bound is the one real limit the server
 * already imposes on this flow: `getBusinessClosures`'s `MAX_RANGE_DAYS`
 * (120). That is the furthest out the portal can find out whether a date is
 * closed, and offering a date whose closure status cannot be resolved is
 * exactly what that callable exists to prevent. When a real horizon setting
 * arrives, this constant is the single place the picker reads it from.
 */
const val BOOKING_HORIZON_DAYS = 120

/** The last (inclusive) date a booking may be placed on, counting from [today]. */
fun bookingHorizonEnd(today: LocalDate, horizonDays: Int = BOOKING_HORIZON_DAYS): LocalDate =
    LocalDate.fromEpochDays(today.toEpochDays() + horizonDays)

/** Months-since-year-0 ordinal, so two dates' months compare with `<`/`>`. */
fun monthIndex(d: LocalDate): Int = d.year * 12 + d.month.ordinal

/** The 1st of the month [delta] months away from [anchor] (negative goes back). */
fun shiftMonth(anchor: LocalDate, delta: Int): LocalDate {
    val total = monthIndex(anchor) + delta
    return LocalDate(total / 12, total % 12 + 1, 1)
}

/**
 * Every real calendar day in [anchor]'s month — 28, 29, 30 or 31 of them.
 *
 * The old `SimpleMonthPicker` counted a flat 28 days from the 1st, which
 * quietly ate the 29th through 31st of every long month; with a pageable
 * picker it is simply wrong.
 */
fun bookingMonthDays(anchor: LocalDate): List<LocalDate> {
    val first = LocalDate(anchor.year, anchor.month, 1)
    val nextFirst = shiftMonth(anchor, 1)
    val length = (nextFirst.toEpochDays() - first.toEpochDays()).toInt()
    return (0 until length).map { LocalDate.fromEpochDays(first.toEpochDays() + it) }
}

/**
 * Whether [day] may be booked: today or later (a past date is refused by
 * `requestBooking` server-side anyway) and no later than the horizon.
 */
fun isBookableDay(day: LocalDate, today: LocalDate, horizonEnd: LocalDate): Boolean =
    day >= today && day <= horizonEnd

/** True when the picker may page back from [anchor] (never before today's month). */
fun canPageBack(anchor: LocalDate, today: LocalDate): Boolean = monthIndex(anchor) > monthIndex(today)

/** True when the picker may page forward from [anchor] (never past the horizon's month). */
fun canPageForward(anchor: LocalDate, horizonEnd: LocalDate): Boolean =
    monthIndex(anchor) < monthIndex(horizonEnd)

/** Stable "YYYY-MM-DD" key, matching the web `dateKey` and the closure wire format. */
fun bookingDateKey(d: LocalDate): String {
    val m = (d.month.ordinal + 1).toString().padStart(2, '0')
    val day = d.day.toString().padStart(2, '0')
    return "${d.year}-$m-$day"
}
