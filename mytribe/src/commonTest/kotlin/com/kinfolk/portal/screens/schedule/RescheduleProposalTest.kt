package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.screens.schedule.util.parseClock24
import com.kinfolk.portal.screens.schedule.util.proposedStartMillis
import com.kinfolk.portal.screens.schedule.util.rescheduleProblem
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The arithmetic and the refusals behind the reschedule ask (#469). */
class RescheduleProposalTest {

    private val utc = TimeZone.UTC

    @Test
    fun `a date and a time become the instant the household meant`() {
        // 2026-08-18T13:00:00Z.
        assertEquals(
            1_787_058_000_000L,
            proposedStartMillis(LocalDate(2026, 8, 18), "13:00", utc),
        )
    }

    @Test
    fun `midnight is a real time, not a missing one`() {
        assertEquals(
            1_787_011_200_000L,
            proposedStartMillis(LocalDate(2026, 8, 18), "00:00", utc),
        )
    }

    @Test
    fun `no date picked yet is null, never today by default`() {
        assertNull(proposedStartMillis(null, "13:00", utc))
    }

    @Test
    fun `a half-typed time is null rather than a guess`() {
        assertNull(proposedStartMillis(LocalDate(2026, 8, 18), "13", utc))
        assertNull(proposedStartMillis(LocalDate(2026, 8, 18), "", utc))
        assertNull(proposedStartMillis(LocalDate(2026, 8, 18), "1pm", utc))
    }

    @Test
    fun `parseClock24 refuses hours and minutes off the clock`() {
        assertEquals(13, parseClock24("13:05")?.hour)
        assertEquals(5, parseClock24("13:05")?.minute)
        assertNull(parseClock24("24:00"))
        assertNull(parseClock24("12:60"))
        assertNull(parseClock24("-1:00"))
    }

    @Test
    fun `parseClock24 tolerates the whitespace a keyboard leaves behind`() {
        assertEquals(9, parseClock24(" 09:30 ")?.hour)
    }

    @Test
    fun `an unfinished form asks for the missing half`() {
        assertEquals("Pick a date and time first.", rescheduleProblem(null, nowMs = 1_787_058_000_000L))
    }

    @Test
    fun `a time in the past is refused here, before it reaches the server`() {
        val now = 1_787_058_000_000L
        assertEquals("Pick a time in the future.", rescheduleProblem(now - 1, now))
        assertEquals("Pick a time in the future.", rescheduleProblem(now, now))
    }

    @Test
    fun `a future time has nothing to say about it`() {
        val now = 1_787_058_000_000L
        assertNull(rescheduleProblem(now + 60_000L, now))
    }
}
