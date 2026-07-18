package com.tribetails.auntieos.ui.admin.scheduling

import java.time.LocalDate
import java.time.ZoneId

/**
 * AO-25: pure date math for the admin New-booking-request form. Kept out of the
 * composable so it is unit-testable. Mirrors the web `lib/newBooking.ts`.
 *
 * Weekdays use the JS/backend convention (0 = Sunday … 6 = Saturday), the same
 * `weeklyDays` the createMultiDateBookingRequest callable stores, so the UI
 * selection is sent through unchanged. All times are LOCAL (the operator's zone).
 */
object NewBookingMath {

    /** Epoch ms in the system (local) zone for a wall-clock date + time. */
    fun localMs(date: LocalDate, hour: Int, minute: Int): Long =
        date.atTime(hour, minute).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

    /** java.time weekday (Mon=1..Sun=7) mapped to the JS convention (Sun=0..Sat=6). */
    fun jsWeekday(date: LocalDate): Int = date.dayOfWeek.value % 7

    /**
     * Weekly recurrence: walk [weeks] * 7 days from [startDate], include any day
     * whose (JS) weekday is in [weekdays], at [hour]:[minute]. Ascending, de-duped
     * epoch ms. Empty when no weekday is selected or [weeks] < 1.
     */
    fun expandWeekly(
        startDate: LocalDate,
        hour: Int,
        minute: Int,
        weekdays: Set<Int>,
        weeks: Int,
    ): List<Long> {
        if (weekdays.isEmpty() || weeks < 1) return emptyList()
        val out = sortedSetOf<Long>()
        for (i in 0 until weeks * 7) {
            val d = startDate.plusDays(i.toLong())
            if (jsWeekday(d) in weekdays) out.add(localMs(d, hour, minute))
        }
        return out.toList()
    }

    /** De-dupes + sorts specific-date visit start times, dropping nulls. */
    fun visitMs(startTimes: List<Long?>): List<Long> =
        startTimes.filterNotNull().toSortedSet().toList()

    /** True when every start time is at/after now (with a 1-minute grace). */
    fun allInFuture(startTimesMs: List<Long>, nowMs: Long): Boolean =
        startTimesMs.all { it >= nowMs - 60_000 }
}
