package com.tribetails.auntieos.ui.admin.scheduling

import java.time.Instant
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

    /**
     * The zone Material3's `DatePickerState` speaks in, which is NOT the device's.
     *
     * `rememberDatePickerState(initialSelectedDateMillis = …)` and
     * `selectedDateMillis` are both UTC MIDNIGHT of the calendar day, by M3's own
     * contract: the picker shows a bare calendar with no clock, so it has no
     * wall-clock time to be local about.
     *
     * The dialog used to seed that state through `ZoneId.systemDefault()` and read
     * it back through UTC. The two disagree everywhere east of Greenwich: seeding
     * 2027-08-16 in Auckland (UTC+12) produces 2027-08-15T12:00Z, whose UTC day is
     * the 15th, so the picker opened on the day BEFORE the one it was given, and
     * an operator who accepted the highlighted day got a visit 24 hours early.
     * The fix is not to pick a zone, it is to use the SAME one on both sides, and
     * `pickerRoundTrip` in NewBookingMathTest pins that.
     */
    private val PICKER_ZONE: ZoneId = ZoneId.of("UTC")

    /** The `initialSelectedDateMillis` that makes an M3 DatePicker open on [date]. */
    fun pickerSeedMs(date: LocalDate): Long =
        date.atStartOfDay(PICKER_ZONE).toInstant().toEpochMilli()

    /** The calendar day an M3 DatePicker's `selectedDateMillis` names. */
    fun pickerPickedDate(ms: Long): LocalDate =
        Instant.ofEpochMilli(ms).atZone(PICKER_ZONE).toLocalDate()

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
