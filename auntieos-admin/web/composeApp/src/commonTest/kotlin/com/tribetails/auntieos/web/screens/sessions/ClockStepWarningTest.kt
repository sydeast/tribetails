package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone

/**
 * #2039, the console half. The same cases and sentences as the web suite
 * (`src/lib/clockStepWarning.test.ts`). The walk's visit: 45 minutes booked
 * for 22:45 Chicago on Nov 10, 2026, which is 04:45 UTC on Nov 11.
 */
@OptIn(ExperimentalTime::class)
class ClockStepWarningTest {

    private val chicago = TimeZone.of("America/Chicago")
    private val min = 60_000L
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilliseconds()
    private val start = ms("2026-11-11T04:45:00Z")
    private fun iso(at: Long) = Instant.fromEpochMilliseconds(at).toString()
    private val visit = KinCareSession(
        _id = "v",
        startTime = "2026-11-11T04:45:00Z",
        endTime = "2026-11-11T05:30:00Z",
        serviceDurationMinutes = 45,
    )

    @Test
    fun `keeps the two thresholds the web and Android hold`() {
        assertEquals(30, EARLY_ARRIVAL_WARNING_MINUTES)
        assertEquals(0.5, SHORT_VISIT_WARNING_SHARE)
        assertEquals("Check the time", CLOCK_STEP_WARNING_TITLE)
    }

    @Test
    fun `warns on a clock-out before the booked start, the walk's case`() {
        val now = start - 43 * min
        assertEquals(
            "This visit is booked to start at 22:45, 43 minutes from now. Clocking out now ends it before it was due to begin.",
            clockStepWarning(AuntieTimeAction.Departed, visit.copy(arrivedAt = iso(now - min)), now, chicago),
        )
    }

    @Test
    fun `warns on a clock-out under half the booked length after clock-in`() {
        assertEquals(
            "Only 1 minute since clock-in. This visit is booked for 45 minutes.",
            clockStepWarning(AuntieTimeAction.Departed, visit.copy(arrivedAt = iso(start)), start + min, chicago),
        )
    }

    @Test
    fun `says nothing at half the length or later`() {
        assertNull(clockStepWarning(AuntieTimeAction.Departed, visit.copy(arrivedAt = iso(start)), start + 23 * min, chicago))
        assertNull(clockStepWarning(AuntieTimeAction.Departed, visit.copy(arrivedAt = iso(start)), start + 45 * min, chicago))
    }

    @Test
    fun `reads a clock-in an older console stamped on the business clock with no zone`() {
        assertEquals(
            "Only 2 minutes since clock-in. This visit is booked for 45 minutes.",
            clockStepWarning(AuntieTimeAction.Departed, visit.copy(arrivedAt = "2026-11-10T22:45:00"), start + 2 * min, chicago),
        )
    }

    @Test
    fun `reads a visit start stored as a wall clock`() {
        val wall = KinCareSession(_id = "w", startTime = "2026-11-10T22:45:00", serviceDurationMinutes = 45)
        assertEquals(
            "This visit is booked to start at 22:45, 10 minutes from now. Clocking out now ends it before it was due to begin.",
            clockStepWarning(AuntieTimeAction.Departed, wall, start - 10 * min, chicago),
        )
    }

    @Test
    fun `warns on a clock-in more than half an hour early, and not at 30 minutes`() {
        assertEquals(
            "This visit is booked for 22:45, 47 minutes from now.",
            clockStepWarning(AuntieTimeAction.Arrived, visit, start - 47 * min, chicago),
        )
        assertNull(clockStepWarning(AuntieTimeAction.Arrived, visit, start - 30 * min, chicago))
        assertNull(clockStepWarning(AuntieTimeAction.Arrived, visit, start + 5 * min, chicago))
    }

    @Test
    fun `places an 11-30 PM visit on the night clocks go back`() {
        // Nov 1, 2026: 23:30 CST is 05:30 UTC on Nov 2.
        val late = KinCareSession(_id = "l", startTime = "2026-11-02T05:30:00Z", serviceDurationMinutes = 30)
        assertEquals(
            "This visit is booked for 23:30, 1 hour 30 minutes from now.",
            clockStepWarning(AuntieTimeAction.Arrived, late, ms("2026-11-02T04:00:00Z"), chicago),
        )
    }

    @Test
    fun `places a 12-30 AM visit on the night clocks go forward`() {
        // Mar 8, 2026: 00:30 CST is 06:30 UTC; a clock-out at 00:20 is before it starts.
        val early = KinCareSession(_id = "e", startTime = "2026-03-08T06:30:00Z", serviceDurationMinutes = 30)
        assertEquals(
            "This visit is booked to start at 00:30, 10 minutes from now. Clocking out now ends it before it was due to begin.",
            clockStepWarning(AuntieTimeAction.Departed, early, ms("2026-03-08T06:20:00Z"), chicago),
        )
    }

    @Test
    fun `says nothing it cannot back`() {
        assertNull(clockStepWarning(AuntieTimeAction.Arrived, KinCareSession(_id = "x"), start, chicago))
        assertNull(clockStepWarning(AuntieTimeAction.Departed, KinCareSession(_id = "x", startTime = visit.startTime), start + min, chicago))
        assertNull(
            clockStepWarning(
                AuntieTimeAction.Departed,
                KinCareSession(_id = "x", startTime = visit.startTime, arrivedAt = visit.startTime),
                start + min,
                chicago,
            ),
        )
        assertNull(clockStepWarning(AuntieTimeAction.OnMyWay, visit, start - 300 * min, chicago))
        assertNull(clockStepWarning(AuntieTimeAction.UndoArrived, visit, start - 300 * min, chicago))
    }

    @Test
    fun `span words read like a person would say them`() {
        assertEquals("less than a minute", spanWords(0.4))
        assertEquals("1 minute", spanWords(1.0))
        assertEquals("43 minutes", spanWords(43.0))
        assertEquals("1 hour", spanWords(60.0))
        assertEquals("2 hours 5 minutes", spanWords(125.0))
    }
}
