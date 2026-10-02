@file:OptIn(kotlin.time.ExperimentalTime::class)

package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.DEFAULT_BUSINESS_TIME_ZONE
import com.tribetails.auntieos.web.screens.settings.resolveBusinessTimeZone
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atTime
import kotlinx.datetime.isoDayNumber
import kotlinx.datetime.plus
import kotlinx.datetime.toInstant

/**
 * AO-25: pure date math for the admin New-booking-request form. Kept out of the
 * composable so it is unit-testable. Mirrors the android [NewBookingMath] and the
 * web `lib/newBooking.ts`.
 *
 * Weekdays use the JS/backend convention (0 = Sunday … 6 = Saturday), the same
 * `weeklyDays` the createMultiDateBookingRequest callable stores, so the UI
 * selection is sent through unchanged.
 * kotlinx.datetime only (no java.time), so it compiles on wasm and jvm alike.
 *
 * #1150: every visit time is the BUSINESS's wall clock, built in [businessTimeZone]
 * (America/Chicago when `business_settings.timeZone` is unset or unusable, #1109).
 * The server reads the instants in that zone for dates, blocks, closures and
 * conflicts, so an operator whose machine is in another zone still books the
 * business's 9:00. The web and Android wizards do the same.
 */
object NewBookingMath {

    /** Epoch ms for a wall-clock date + time read in [zone], the business's zone (#1150). */
    fun localMs(date: LocalDate, hour: Int, minute: Int, zone: TimeZone): Long =
        date.atTime(hour, minute).toInstant(zone).toEpochMilliseconds()

    /**
     * `business_settings.timeZone` as a zone: the stored one when this runtime
     * can read it, else America/Chicago, the server's own default (#1109).
     * Never the machine's zone.
     */
    fun businessTimeZone(stored: String?): TimeZone =
        try {
            TimeZone.of(resolveBusinessTimeZone(stored))
        } catch (e: IllegalArgumentException) {
            TimeZone.of(DEFAULT_BUSINESS_TIME_ZONE)
        }

    /** kotlinx weekday (Mon=1..Sun=7) mapped to the JS convention (Sun=0..Sat=6). */
    fun jsWeekday(date: LocalDate): Int = date.dayOfWeek.isoDayNumber % 7

    /**
     * Weekly recurrence: walk [weeks] * 7 days from [startDate], include any day
     * whose (JS) weekday is in [weekdays], at [hour]:[minute] in [zone]. Ascending, de-duped
     * epoch ms. Empty when no weekday is selected or [weeks] < 1.
     */
    fun expandWeekly(
        startDate: LocalDate,
        hour: Int,
        minute: Int,
        weekdays: Set<Int>,
        weeks: Int,
        zone: TimeZone,
    ): List<Long> {
        if (weekdays.isEmpty() || weeks < 1) return emptyList()
        val out = mutableListOf<Long>()
        for (i in 0 until weeks * 7) {
            val d = startDate.plus(i, DateTimeUnit.DAY)
            if (jsWeekday(d) in weekdays) out.add(localMs(d, hour, minute, zone))
        }
        return out.distinct().sorted()
    }

    /** De-dupes + sorts specific-date visit start times, dropping nulls. */
    fun visitMs(startTimes: List<Long?>): List<Long> =
        startTimes.filterNotNull().distinct().sorted()

    /** True when every start time is at/after now (with a 1-minute grace). */
    fun allInFuture(startTimesMs: List<Long>, nowMs: Long): Boolean =
        startTimesMs.all { it >= nowMs - 60_000 }
}
