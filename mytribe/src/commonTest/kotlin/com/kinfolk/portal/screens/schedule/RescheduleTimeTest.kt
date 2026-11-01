package com.kinfolk.portal.screens.schedule
import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.BookingPolicy
import com.kinfolk.portal.portal.TimeBlock
import com.kinfolk.portal.portal.WeekdayHours
import com.kinfolk.portal.screens.schedule.util.blockChoices
import com.kinfolk.portal.screens.schedule.util.closedDaysFor
import com.kinfolk.portal.screens.schedule.util.hoursOn
import com.kinfolk.portal.screens.schedule.util.rescheduleModes
import com.kinfolk.portal.screens.schedule.util.resolveProposal
import com.kinfolk.portal.screens.schedule.util.sundayZeroWeekday
import com.kinfolk.portal.screens.schedule.util.zonedWallClockToMs
import kotlinx.datetime.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** #1284: the reschedule form's arithmetic, in lockstep with web `rescheduleTime.test.ts`. */
class RescheduleTimeTest {
    private val chi = "America/Chicago"
    private val hours = (0..6).map { d ->
        if (d == 0) WeekdayHours(d, false, null, null) else WeekdayHours(d, true, "09:00", "17:00")
    }
    private val morning = TimeBlock("morning", "Morning", "08:00", "12:00", 240)
    private val late = TimeBlock("late", "Late", "20:00", "24:00", 240)
    private fun ms(day: LocalDate, hhmm: String) = zonedWallClockToMs(day, hhmm, chi)!!
    // 2026-11-16 is a Monday.
    private val monday = LocalDate(2026, 11, 16)
    @Test
    fun `reads the Chicago wall clock in standard and daylight time`() {
        // 09:00 CST (UTC-6) and 09:00 CDT (UTC-5).
        assertEquals(1_794_754_800_000L, zonedWallClockToMs(LocalDate(2026, 11, 15), "09:00", chi))
        assertEquals(1_784_124_000_000L, zonedWallClockToMs(LocalDate(2026, 7, 15), "09:00", chi))
    }
    @Test
    fun `lands on the right side of the spring-forward change`() {
        // 2026-03-08: 03:30 CDT is 08:30Z, 01:30 CST is 07:30Z.
        assertEquals(1_772_958_600_000L, zonedWallClockToMs(LocalDate(2026, 3, 8), "03:30", chi))
        assertEquals(1_772_955_000_000L, zonedWallClockToMs(LocalDate(2026, 3, 8), "01:30", chi))
    }
    @Test
    fun `24 00 is the next midnight and garbage is null`() {
        assertEquals(
            zonedWallClockToMs(LocalDate(2026, 11, 16), "00:00", chi),
            zonedWallClockToMs(LocalDate(2026, 11, 15), "24:00", chi),
        )
        assertNull(zonedWallClockToMs(LocalDate(2026, 11, 15), "25:00", chi))
        assertNull(zonedWallClockToMs(LocalDate(2026, 11, 15), "09:00", "Not/AZone"))
    }
    @Test
    fun `weekday numbering is Sunday zero`() {
        assertEquals(0, LocalDate(2026, 11, 15).sundayZeroWeekday())
        assertEquals(1, monday.sundayZeroWeekday())
        assertEquals(6, LocalDate(2026, 11, 21).sundayZeroWeekday())
    }
    @Test
    fun `closed weekdays join the company closures`() {
        val out = closedDaysFor(mapOf("2026-11-04" to "Owner away"), hours, LocalDate(2026, 11, 1), 14)
        assertEquals("Owner away", out["2026-11-04"])
        assertEquals("Sundays", out["2026-11-01"])
        assertEquals("Sundays", out["2026-11-08"])
        assertEquals("Sundays", out["2026-11-15"])
        assertTrue("2026-11-02" !in out)
    }
    @Test
    fun `no hours on file adds nothing and hoursOn needs all seven days`() {
        assertTrue(closedDaysFor(emptyMap(), emptyList(), LocalDate(2026, 11, 1), 14).isEmpty())
        assertEquals("09:00", hoursOn(monday, hours)?.startTime)
        assertNull(hoursOn(monday, hours.take(3)))
    }
    @Test
    fun `modes follow the policy and a start-time service stays on the clock`() {
        val both = BookingPolicy(true, true, BookingMode.TimeBlock, listOf(morning))
        assertEquals(listOf(BookingMode.TimeBlock, BookingMode.SpecificTime), rescheduleModes(both, "s1").modes)
        assertEquals(BookingMode.TimeBlock, rescheduleModes(both, "s1").initial)
        assertEquals(
            listOf(BookingMode.TimeBlock),
            rescheduleModes(both.copy(allowSpecificTimeBooking = false), "s1").modes,
        )
        val night = both.copy(allowSpecificTimeBooking = false, startTimeServiceIds = setOf("night"))
        assertEquals(listOf(BookingMode.SpecificTime), rescheduleModes(night, "night").modes)
    }
    @Test
    fun `a block that has not started is carried on its first minute`() {
        val out = blockChoices(monday, listOf(morning), ms(monday, "00:00"), chi)
        assertEquals(ms(monday, "08:00"), out.single().startMs)
    }
    @Test
    fun `a block already open starts a little after now on a five minute step`() {
        val out = blockChoices(monday, listOf(morning), ms(monday, "09:02"), chi)
        assertEquals(ms(monday, "09:20"), out.single().startMs)
    }
    @Test
    fun `a block closing too soon or already over is dropped, and 24 00 reads as midnight`() {
        assertTrue(blockChoices(monday, listOf(morning), ms(monday, "11:50"), chi).isEmpty())
        assertTrue(blockChoices(monday, listOf(morning), ms(monday, "13:00"), chi).isEmpty())
        assertEquals(1, blockChoices(monday, listOf(late), ms(monday, "21:00"), chi).size)
    }
    private fun propose(
        day: LocalDate? = monday,
        mode: BookingMode = BookingMode.SpecificTime,
        time: String = "10:00",
        blockId: String? = null,
        weekly: List<WeekdayHours> = hours,
        startTimeService: Boolean = false,
    ) = resolveProposal(
        day = day,
        mode = mode,
        time = time,
        blockId = blockId,
        blocks = listOf(morning),
        weekly = weekly,
        timeZoneId = chi,
        nowMs = ms(LocalDate(2026, 11, 10), "12:00"),
        startTimeService = startTimeService,
    )
    @Test
    fun `a day and clock time become a Chicago instant with no block`() {
        val r = propose()
        assertEquals(ms(monday, "10:00"), r.proposal?.startMs)
        assertNull(r.proposal?.timeBlockId)
        assertNull(r.problem)
    }
    @Test
    fun `no day yet says nothing`() {
        val r = propose(day = null)
        assertNull(r.proposal)
        assertNull(r.problem)
    }
    @Test
    fun `2 AM is refused with that days hours in the sentence`() {
        val r = propose(time = "02:00")
        assertNull(r.proposal)
        assertEquals("We are open 09:00 to 17:00 on Mondays. Pick a time inside those hours.", r.problem)
    }
    @Test
    fun `the closing minute is outside, like the server`() {
        assertNull(propose(time = "17:00").proposal)
        assertNotNull(propose(time = "16:59").proposal)
    }
    @Test
    fun `a start-time service and a day with no hours on file are not bounded`() {
        assertNotNull(propose(time = "20:00", startTimeService = true).proposal)
        assertNotNull(propose(time = "02:00", weekly = emptyList()).proposal)
    }
    @Test
    fun `a block carries its id at the first minute and waits until one is chosen`() {
        val r = propose(mode = BookingMode.TimeBlock, blockId = "morning")
        assertEquals(ms(monday, "08:00"), r.proposal?.startMs)
        assertEquals("morning", r.proposal?.timeBlockId)
        val waiting = propose(mode = BookingMode.TimeBlock, blockId = null)
        assertNull(waiting.proposal)
        assertNull(waiting.problem)
    }
    @Test
    fun `a half typed time is not a time`() {
        assertNull(propose(time = "1").proposal)
        assertNull(propose(time = "").problem)
    }
}
