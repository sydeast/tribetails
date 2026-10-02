package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.businessZone
import com.tribetails.auntieos.domain.rescheduleArgsForDrop
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.util.TimeZone

/**
 * #1158: the operator's schedule reads the BUSINESS's clock. The phone here is in
 * Los Angeles and the business in Chicago, two hours ahead, so a today, a now or
 * a note lock still on the phone's clock fails here.
 */
class ScheduleBusinessClockTest {

    private val chicago = businessZone("America/Chicago")
    private lateinit var original: TimeZone

    @Before
    fun phoneInLosAngeles() {
        original = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("America/Los_Angeles"))
    }

    @After
    fun restoreZone() {
        TimeZone.setDefault(original)
    }

    private fun at(iso: String): Clock = Clock.fixed(Instant.parse(iso), ZoneOffset.UTC)

    @Test
    fun `today is the business day when the phone is still on the day before`() {
        // 05:30Z on Oct 6 is 00:30 Oct 6 in Chicago and 22:30 Oct 5 in LA.
        assertEquals(LocalDate.of(2026, 10, 6), businessToday(chicago, at("2026-10-06T05:30:00Z")))
    }

    @Test
    fun `now is the business wall clock`() {
        // 19:30Z is 14:30 in Chicago and 12:30 on the LA phone.
        assertEquals(LocalDateTime.of(2026, 10, 5, 14, 30), businessNow(chicago, at("2026-10-05T19:30:00Z")))
    }

    @Test
    fun `an unset zone is the server default Chicago, never the phone`() {
        assertEquals(chicago, businessZone(null))
        assertEquals(chicago, businessZone(""))
    }

    @Test
    fun `the Home dashboard loads the business day's visits`() {
        // Business today is Oct 5 in Chicago (CDT): 05:00Z to 05:00Z the next day.
        assertEquals(
            "2026-10-05T05:00:00Z" to "2026-10-06T05:00:00Z",
            businessDayBoundsIso(chicago, at("2026-10-05T19:30:00Z")),
        )
    }

    @Test
    fun `the note lock reads a zone-less start as the business wall clock`() {
        // 14:00 Chicago is 19:00Z. On the LA phone it would be 21:00Z, and notes
        // would stay open two hours past the cutoff.
        assertEquals(Instant.parse("2026-10-05T19:00:00Z").toEpochMilli(), visitStartMs("2026-10-05T14:00:00", chicago))
        assertEquals(Instant.parse("2026-10-05T19:00:00Z").toEpochMilli(), visitStartMs("2026-10-05T19:00:00Z", chicago))
        assertNull(visitStartMs("", chicago))
    }

    @Test
    fun `a visit is active against the business now, not the phone's`() {
        val start = LocalDateTime.of(2026, 10, 5, 14, 0)
        val end = LocalDateTime.of(2026, 10, 5, 15, 0)
        assertTrue(isActiveAt(start, end, businessNow(chicago, at("2026-10-05T19:30:00Z"))))
        assertFalse(isActiveAt(start, end, businessNow(chicago, at("2026-10-05T21:30:00Z"))))
    }

    @Test
    fun `a 14_00 visit sits on the 14_00 row beside a 14_00 block, and a drop on 15_00 sends 15_00 Chicago`() {
        // The visit's zone-less start is the business wall clock, placed by its own hour.
        val start = LocalDateTime.parse("2026-10-05T14:00:00")
        assertEquals(14 * 60, start.hour * 60 + start.minute)
        assertEquals(14 * 60 - 8 * 60, busyPlacement("14:00", "15:00")!!.topMinutes)
        val args = rescheduleArgsForDrop(
            KinCareSession(id = "s1", startTime = "2026-10-05T14:00:00", endTime = "2026-10-05T15:00:00"),
            "2026-10-05",
            15 * 60,
            snapMinutes = 1,
        )!!
        assertEquals("2026-10-05T15:00:00", args.startTime)
        // The server reads it on the business clock: 15:00 Chicago is 20:00Z.
        assertEquals(Instant.parse("2026-10-05T20:00:00Z").toEpochMilli(), visitStartMs(args.startTime, chicago))
    }
}
