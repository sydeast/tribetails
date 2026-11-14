package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** #2039: the same cases and sentences as the web's `clockStepWarning.test.ts`. */
class ClockStepWarningTest {
    private val chicago = ZoneId.of("America/Chicago")
    private val min = 60_000L

    // The walk's visit: 45 minutes booked for 22:45 Chicago on Nov 10, 2026 (04:45 UTC Nov 11).
    private val start = "2026-11-11T04:45:00.000Z"
    private val end = "2026-11-11T05:30:00.000Z"
    private val startMs = Instant.parse(start).toEpochMilli()

    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    @Test
    fun `the thresholds match the other clients`() {
        assertEquals(30, EARLY_ARRIVAL_WARNING_MINUTES)
        assertEquals(0.5, SHORT_VISIT_WARNING_SHARE, 0.0)
        assertEquals("Check the time", CLOCK_STEP_WARNING_TITLE)
    }

    @Test
    fun `a clock-out before the booked start warns, the walk's case`() {
        val now = startMs - 43 * min
        assertEquals(
            "This visit is booked to start at 22:45, 43 minutes from now. Clocking out now ends it before it was due to begin.",
            clockStepWarning(ClockStep.DEPARTED, start, end, 45, iso(now - min), now, chicago),
        )
    }

    @Test
    fun `a clock-out under half the booked length warns`() {
        assertEquals(
            "Only 1 minute since clock-in. This visit is booked for 45 minutes.",
            clockStepWarning(ClockStep.DEPARTED, start, end, 45, start, startMs + min, chicago),
        )
    }

    @Test
    fun `a clock-out at half the length or later says nothing`() {
        assertNull(clockStepWarning(ClockStep.DEPARTED, start, end, 45, start, startMs + 23 * min, chicago))
        assertNull(clockStepWarning(ClockStep.DEPARTED, start, end, 45, start, startMs + 45 * min, chicago))
    }

    @Test
    fun `the length falls back to the window when none is stored`() {
        assertEquals(
            "Only 5 minutes since clock-in. This visit is booked for 45 minutes.",
            clockStepWarning(ClockStep.DEPARTED, start, end, 0, start, startMs + 5 * min, chicago),
        )
    }

    @Test
    fun `a clock-in stamped on the business clock with no zone is read as business time`() {
        assertEquals(
            "Only 2 minutes since clock-in. This visit is booked for 45 minutes.",
            clockStepWarning(ClockStep.DEPARTED, start, end, 45, "2026-11-10T22:45:00", startMs + 2 * min, chicago),
        )
    }

    @Test
    fun `a start stored as a wall clock is read as business time`() {
        assertEquals(
            "This visit is booked to start at 22:45, 10 minutes from now. Clocking out now ends it before it was due to begin.",
            clockStepWarning(ClockStep.DEPARTED, "2026-11-10T22:45:00", "", 45, null, startMs - 10 * min, chicago),
        )
    }

    @Test
    fun `a clock-in more than half an hour early warns, and not at 30 minutes`() {
        assertEquals(
            "This visit is booked for 22:45, 47 minutes from now.",
            clockStepWarning(ClockStep.ARRIVED, start, end, 45, null, startMs - 47 * min, chicago),
        )
        assertNull(clockStepWarning(ClockStep.ARRIVED, start, end, 45, null, startMs - 30 * min, chicago))
        assertNull(clockStepWarning(ClockStep.ARRIVED, start, end, 45, null, startMs + 5 * min, chicago))
    }

    @Test
    fun `an 11 30 PM visit on the night clocks go back, Nov 1 2026`() {
        // 23:30 CST on Nov 1 is 05:30 UTC Nov 2.
        assertEquals(
            "This visit is booked for 23:30, 1 hour 30 minutes from now.",
            clockStepWarning(
                ClockStep.ARRIVED, "2026-11-02T05:30:00.000Z", "", 30, null,
                Instant.parse("2026-11-02T04:00:00Z").toEpochMilli(), chicago,
            ),
        )
    }

    @Test
    fun `a 12 30 AM visit on the night clocks go forward, Mar 8 2026`() {
        // 00:30 CST Mar 8 is 06:30 UTC.
        assertEquals(
            "This visit is booked to start at 00:30, 10 minutes from now. Clocking out now ends it before it was due to begin.",
            clockStepWarning(
                ClockStep.DEPARTED, "2026-03-08T06:30:00.000Z", "", 30, null,
                Instant.parse("2026-03-08T06:20:00Z").toEpochMilli(), chicago,
            ),
        )
    }

    @Test
    fun `nothing it cannot back says nothing`() {
        assertNull(clockStepWarning(ClockStep.ARRIVED, "", "", 0, null, startMs, chicago))
        assertNull(clockStepWarning(ClockStep.DEPARTED, start, "", 0, null, startMs + min, chicago))
        assertNull(clockStepWarning(ClockStep.DEPARTED, start, "", 0, start, startMs + min, chicago))
        assertNull(clockStepWarning(ClockStep.DEPARTED, null, null, 0, null, startMs, chicago))
    }

    @Test
    fun `span words read like a person says them`() {
        assertEquals("less than a minute", spanWords(0.4))
        assertEquals("1 minute", spanWords(1.0))
        assertEquals("43 minutes", spanWords(43.0))
        assertEquals("1 hour", spanWords(60.0))
        assertEquals("2 hours 5 minutes", spanWords(125.0))
    }
}
