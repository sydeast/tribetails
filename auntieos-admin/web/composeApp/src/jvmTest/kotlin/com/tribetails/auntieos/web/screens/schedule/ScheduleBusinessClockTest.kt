package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.rescheduleArgsForDrop
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/**
 * #1158: the desktop Schedule screen is drawn on the BUSINESS's clock. The
 * machine here is in Los Angeles and the business in Chicago, two hours ahead,
 * so a grid, a today or a prefill still on the machine's clock fails here.
 *
 * JVM-only because moving the machine's zone is `java.util.TimeZone.setDefault`,
 * which is what kotlinx `TimeZone.currentSystemDefault()` reads.
 */
@OptIn(ExperimentalTime::class)
class ScheduleBusinessClockTest {

    private lateinit var original: java.util.TimeZone

    @BeforeTest
    fun machineInLosAngeles() {
        original = java.util.TimeZone.getDefault()
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"))
    }

    @AfterTest
    fun restoreZone() {
        java.util.TimeZone.setDefault(original)
    }

    private val chicago = TimeZone.of("America/Chicago")

    @Test
    fun the_screen_clock_is_the_business_zone_not_the_machine() {
        // 19:30Z is 14:30 in Chicago and 12:30 on the LA machine.
        val clock = scheduleClockOf("America/Chicago", Instant.parse("2026-10-05T19:30:00Z"))
        assertEquals(chicago, clock.zone)
        assertEquals(14 * 60 + 30, clock.nowMinutes)
        assertEquals(LocalDate(2026, 10, 5), clock.today)
    }

    @Test
    fun today_is_the_business_day_when_the_machine_is_still_on_the_day_before() {
        // 05:30Z on Oct 6 is 00:30 Oct 6 in Chicago and 22:30 Oct 5 in LA.
        val clock = scheduleClockOf("America/Chicago", Instant.parse("2026-10-06T05:30:00Z"))
        assertEquals(LocalDate(2026, 10, 6), clock.today)
    }

    @Test
    fun an_unset_zone_is_the_server_default_chicago_never_the_machine() {
        assertEquals(chicago, scheduleClockOf(null, Instant.parse("2026-10-05T19:30:00Z")).zone)
        assertEquals(chicago, scheduleClockOf("", Instant.parse("2026-10-05T19:30:00Z")).zone)
    }

    @Test
    fun a_14_00_chicago_visit_draws_on_the_14_00_row_beside_a_14_00_busy_block() {
        val zone = scheduleClockOf("America/Chicago", Instant.parse("2026-10-05T12:00:00Z")).zone
        assertEquals(14 * 60, localMinutesOfDay("2026-10-05T19:00:00Z", zone))
        assertEquals("2026-10-05", localDateKey("2026-10-05T19:00:00Z", zone))
        // A zone-less start is already the business wall clock.
        assertEquals(14 * 60, localMinutesOfDay("2026-10-05T14:00:00", zone))
        // The operator's own block, typed on the business clock (#1155), sits on the same row.
        val busy = busyPlacement("14:00", "15:00")!!
        assertEquals(14 * 60 - 8 * 60, busy.topMinutes) // the grid starts at 8a
    }

    @Test
    fun a_drop_on_the_15_00_row_sends_15_00_chicago() {
        val zone = scheduleClockOf("America/Chicago", Instant.parse("2026-10-05T12:00:00Z")).zone
        val session = KinCareSession(
            _id = "s1",
            startTime = "2026-10-05T19:00:00Z",
            endTime = "2026-10-05T20:00:00Z",
            serviceDurationMinutes = 60,
        )
        val args = rescheduleArgsForDrop(session, "2026-10-05", 15 * 60, snapMinutes = 1)!!
        assertEquals("2026-10-05T15:00:00", args.startTime)
        // The server reads a zone-less time as the business wall clock: 15:00 Chicago is 20:00Z.
        assertEquals(Instant.parse("2026-10-05T20:00:00Z"), LocalDateTime.parse(args.startTime).toInstant(zone))
    }

    @Test
    fun the_reschedule_prefill_reads_the_business_clock() {
        assertEquals("2026-10-05", businessDatePart("2026-10-05T19:00:00Z", chicago))
        assertEquals("14:00", businessTimePart("2026-10-05T19:00:00Z", chicago))
        // 03:30Z on Oct 6 is still Oct 5 in Chicago.
        assertEquals("2026-10-05", businessDatePart("2026-10-06T03:30:00Z", chicago))
        assertEquals("22:30", businessTimePart("2026-10-06T03:30:00Z", chicago))
        assertEquals("14:00", businessTimePart("2026-10-05T14:00:00", chicago))
        assertEquals("", businessTimePart("", chicago))
    }
}
