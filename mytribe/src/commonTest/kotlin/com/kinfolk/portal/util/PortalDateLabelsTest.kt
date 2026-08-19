package com.kinfolk.portal.util

import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The two date labels the Gallery and the reschedule ask needed (#469), both
 * mirrored from mytribe/web/src/lib/portalFormat.ts so the same visit reads
 * the same on both clients.
 *
 * Every case pins TimeZone.UTC. Without it these assertions would pass or fail
 * on the machine's own offset, which is the drift the labels exist to avoid.
 */
class PortalDateLabelsTest {

    private val utc = TimeZone.UTC

    /** 2026-08-17T15:30:00Z, a Monday. */
    private val mondayAfternoon = 1_786_980_600_000L

    /** 2026-08-18T13:00:00Z, the Tuesday after it. */
    private val tuesdayMidday = 1_787_058_000_000L

    @Test
    fun `weekdayTime names the day and the local clock time`() {
        assertEquals("Mon, 3:30 PM", weekdayTime(mondayAfternoon, utc))
    }

    @Test
    fun `weekdayTime renders midnight as 12 AM, never 0`() {
        assertEquals("Mon, 12:00 AM", weekdayTime(1_786_924_800_000L, utc))
    }

    @Test
    fun `weekdayTime zero-pads the minute`() {
        assertEquals("Tue, 9:05 AM", weekdayTime(1_787_043_900_000L, utc))
    }

    @Test
    fun `weekdayTime on a null timestamp is empty, never a made-up time`() {
        assertEquals("", weekdayTime(null, utc))
    }

    @Test
    fun `relativeDay counts calendar days, not elapsed hours`() {
        // 15:30 the previous day is under 24 hours before 13:00, and still
        // reads as Yesterday. relativeTime would call this "21h ago".
        assertEquals("Yesterday", relativeDay(mondayAfternoon, nowMillis = tuesdayMidday, timeZone = utc))
    }

    @Test
    fun `relativeDay says Today for anything on the same date`() {
        assertEquals("Today", relativeDay(1_787_043_900_000L, nowMillis = tuesdayMidday, timeZone = utc))
    }

    @Test
    fun `relativeDay counts the days up to a week out`() {
        // 2026-08-14 against 2026-08-18.
        assertEquals("4 days ago", relativeDay(1_786_708_800_000L, nowMillis = tuesdayMidday, timeZone = utc))
    }

    @Test
    fun `relativeDay falls back to a short date past a week`() {
        // 2026-08-01 against 2026-08-18.
        assertEquals("Aug 1", relativeDay(1_785_585_600_000L, nowMillis = tuesdayMidday, timeZone = utc))
    }

    @Test
    fun `relativeDay on a null timestamp is empty`() {
        assertEquals("", relativeDay(null, nowMillis = tuesdayMidday, timeZone = utc))
    }

    @Test
    fun `a photo timestamped slightly ahead of now still reads as Today`() {
        // Clock skew between the server's sentAt and the phone must not
        // produce "-1 days ago".
        assertEquals("Today", relativeDay(tuesdayMidday + 60_000L, nowMillis = tuesdayMidday, timeZone = utc))
    }
}
