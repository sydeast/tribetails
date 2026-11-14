package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.screens.lastVisitByKinfolk
import com.tribetails.auntieos.web.ui.components.formatTime
import com.tribetails.auntieos.web.screens.directory.upcomingVisitsFor
import com.tribetails.auntieos.web.screens.home.nextUpcomingSession
import com.tribetails.auntieos.web.screens.home.overdueVisits
import com.tribetails.auntieos.web.screens.invoices.visitDayLabel
import com.tribetails.auntieos.web.screens.invoices.visitLineDescription
import com.tribetails.auntieos.web.screens.kintales.kinTaleSessionWindow
import com.tribetails.auntieos.web.screens.schedule.canonicalVisitStatus
import com.tribetails.auntieos.web.screens.schedule.isCancelledVisitStatus
import com.tribetails.auntieos.web.screens.schedule.liveVisitsOn
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.datetime.TimeZone

/**
 * #2095, the console half: a visit time stored as a UTC instant reads on the
 * BUSINESS's clock everywhere it is printed or counted, and a zone-less wall
 * clock is already that clock. Every case names its zone, so none depends on
 * the machine running it. The visit in the issue: booked for 11:30 PM on
 * Nov 11 in Chicago, stored as 05:30 UTC on Nov 12.
 */
@OptIn(kotlin.time.ExperimentalTime::class)
class BusinessClockReadsTest {

    private val chicago = TimeZone.of("America/Chicago")
    private val lateInstant = "2026-11-12T05:30:00Z"
    private val lateWall = "2026-11-11T23:30:00"

    private fun visit(id: String, start: String, end: String = "", status: String = "SCHEDULED") =
        KinCareSession(_id = id, kinfolkId = "kf1", kinfolkName = "The Wrens", startTime = start, endTime = end, status = status)

    @Test
    fun `an 11-30 PM visit reads Nov 11 23-30 in both stored shapes`() {
        assertEquals("2026-11-11", businessDayOf(lateInstant, chicago))
        assertEquals("2026-11-11", businessDayOf(lateWall, chicago))
        assertEquals("Nov 11 · 23:30", businessShortDateTime(lateInstant, chicago))
        assertEquals("11:30p", formatTime(lateInstant, chicago))
        assertEquals("11:30p", formatTime(lateWall, chicago))
    }

    @Test
    fun `the KinTale composer prints the window on the business clock`() {
        val s = visit("a", lateInstant, "2026-11-12T06:00:00Z")
        assertEquals("Nov 11 · 23:30 to 00:00", kinTaleSessionWindow(s, chicago))
    }

    @Test
    fun `the detail sheet prints the start on the business clock`() {
        assertEquals("Nov 11 · 23:30", shortIso(lateInstant, 2026, chicago))
        assertEquals("Nov 11 · 23:30", shortIso(lateWall, 2026, chicago))
    }

    @Test
    fun `invoice lines and day labels take the business day`() {
        val u = UninvoicedSession(
            sessionId = "s1", kinfolkId = "kf1", serviceType = "Dog Walk",
            durationMinutes = 30.0, startTime = lateInstant, unitCents = 2500,
        )
        assertEquals("Dog Walk, 2026-11-11", visitLineDescription(u, zone = chicago))
        assertEquals("Nov 11", visitDayLabel(lateInstant, "2026-11-13", chicago))
    }

    @Test
    fun `next upcoming and overdue compare instants, not strings across shapes`() {
        // Now is 10:30 PM Chicago on Nov 11 (04:30 UTC Nov 12), stamped as an instant.
        val now = "2026-11-12T04:30:00Z"
        // A wall-clock visit at 23:00 is still ahead. As strings, "2026-11-11T23:00:00"
        // sorts before "2026-11-12T04:30:00Z" and would have read as past.
        val ahead = visit("ahead", "2026-11-11T23:00:00")
        val past = visit("past", "2026-11-11T20:00:00", end = "2026-11-11T20:30:00")
        assertEquals("ahead", nextUpcomingSession(listOf(past, ahead), now, chicago)?._id)
        assertEquals(listOf("past"), overdueVisits(listOf(past, ahead), now, zone = chicago).map { it.sessionId })
    }

    @Test
    fun `a household's upcoming visits compare instants too`() {
        val now = "2026-11-12T04:30:00Z"
        val ups = upcomingVisitsFor(listOf(visit("w", "2026-11-11T23:00:00"), visit("old", "2026-11-11T21:00:00Z")), "kf1", now, zone = chicago)
        assertEquals(listOf("w"), ups.map { it._id })
    }

    @Test
    fun `last visit is the business day`() {
        val done = KinCareSession(_id = "d", kinfolkId = "kf1", status = "COMPLETED", completedAt = lateInstant)
        assertEquals(mapOf("kf1" to "2026-11-11"), lastVisitByKinfolk(listOf(done), chicago))
    }

    @Test
    fun `clock-change nights keep each visit on its own day`() {
        // Nov 1 2026, clocks go back: 23:30 CST is 05:30 UTC Nov 2.
        assertEquals("2026-11-01", businessDayOf("2026-11-02T05:30:00Z", chicago))
        // Mar 8 2026, clocks go forward: 00:30 CST is 06:30 UTC.
        assertEquals("2026-03-08", businessDayOf("2026-03-08T06:30:00Z", chicago))
        assertEquals("12:30a", formatTime("2026-03-08T06:30:00Z", chicago))
    }

    @Test
    fun `a moved visit keeps a length that crosses UTC midnight`() {
        // 5:30 PM to 6:30 PM Chicago is 23:30Z to 00:30Z: the text read the end
        // as earlier than the start, and the visit fell to 30 minutes.
        val s = visit("a", "2026-11-11T23:30:00Z", end = "2026-11-12T00:30:00Z")
        assertEquals(60, com.tribetails.auntieos.web.screens.resolveDurationMinutes(s, chicago))
        val args = com.tribetails.auntieos.web.screens.rescheduleArgsForDrop(s, "2026-11-13", 17 * 60, snapMinutes = 15)!!
        assertEquals("2026-11-13T18:00:00", args.endTime)
    }
    @Test
    fun `the schedule reads every cancelled spelling as cancelled`() {
        assertTrue(isCancelledVisitStatus("CANCELLED"))
        assertTrue(isCancelledVisitStatus("CANCELED"))
        assertTrue(isCancelledVisitStatus("cancelled"))
        assertFalse(isCancelledVisitStatus("SCHEDULED"))
        assertEquals("CANCELLED", canonicalVisitStatus("canceled"))
        assertEquals("ARRIVED", canonicalVisitStatus("arrived"))
    }
    @Test
    fun `the week and month grids draw and count live visits only`() {
        val day = "2026-11-12"
        val byDate = mapOf(
            day to listOf(
                visit("live", "2026-11-12T18:30:00"),
                visit("two-l", "2026-11-12T19:00:00", status = "CANCELLED"),
                visit("one-l", "2026-11-12T19:30:00", status = "CANCELED"),
                visit("lower", "2026-11-12T20:00:00", status = "cancelled"),
            ),
        )
        assertEquals(listOf("live"), liveVisitsOn(byDate, day).map { it._id })
        assertEquals(emptyList(), liveVisitsOn(byDate, "2026-11-13"))
    }

    @Test
    fun `the notice key is the stamp the write stores, in either shape`() {
        val stamp = "2026-11-12T04:30:00Z"
        val write = kinCareWrite(visit("a", lateInstant), AuntieTimeAction.Arrived, stamp) as KinCareWrite.Patch
        val notice = visitNoticeEventOf(write.fields)
        assertEquals(stamp, write.fields["arrivedAt"])
        assertEquals(stamp, notice?.atIso)
        assertEquals(kotlin.time.Instant.parse(stamp).toEpochMilliseconds(), visitNoticeAtMs(notice!!.atIso))
        // An older console's zone-less stamp still names its record as UTC, as the server reads it.
        assertEquals(kotlin.time.Instant.parse("2026-11-10T16:00:00Z").toEpochMilliseconds(), visitNoticeAtMs("2026-11-10T16:00:00"))
        assertNull(visitNoticeAtMs("soon"))
    }
}
