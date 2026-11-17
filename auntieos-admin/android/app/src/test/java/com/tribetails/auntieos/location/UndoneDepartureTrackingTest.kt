package com.tribetails.auntieos.location

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.model.VisitRoute
import com.tribetails.auntieos.domain.VisitNoticeReach
import com.tribetails.auntieos.domain.gpsLineFor
import com.tribetails.auntieos.domain.visitNoticeConfirmLine
import com.tribetails.auntieos.location.UndoneDepartureTracking.Decision
import com.tribetails.auntieos.notifications.VisitNotifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * #2338: an undone departure resumes GPS on the phone that was tracking the
 * visit, carries on the same route, and the Arrived card says only what this
 * phone knows. #2339: the confirm's words for a step already told.
 */
class UndoneDepartureTrackingTest {
    private val now = Instant.parse("2026-11-17T20:05:00Z").toEpochMilli()
    private val parked = UndoneDepartureTracking.Parked("s1", "kf1", "route1", now - 60_000)

    @Test
    fun `HAPPY - the visit reads Arrived again, so the phone that was tracking it resumes`() {
        assertEquals(Decision.RESUME, UndoneDepartureTracking.decide(parked, "ARRIVED", null, now))
    }

    @Test
    fun `NEGATIVE - a phone already tracking the next visit does not resume, so that route is kept`() {
        assertEquals(Decision.DROP, UndoneDepartureTracking.decide(parked, "ARRIVED", null, now, trackingNow = true))
        // Right after Departed the stop may not have landed: the wait goes on.
        assertEquals(Decision.WAIT, UndoneDepartureTracking.decide(parked, "DEPARTED", null, now, trackingNow = true))
    }
    @Test
    fun `while the undo is still offered the phone keeps waiting`() {
        val until = "2026-11-17T20:09:00.000Z"
        assertEquals(Decision.WAIT, UndoneDepartureTracking.decide(parked, "COMPLETED", until, now))
        assertEquals(Decision.WAIT, UndoneDepartureTracking.decide(parked, "DEPARTED", null, now))
        // No signal, or the visit could not be read: keep waiting.
        assertEquals(Decision.WAIT, UndoneDepartureTracking.decide(parked, null, null, now))
    }

    @Test
    fun `SAD - the undo window closed, so the wait ends`() {
        // Closed 30 s ago: still inside the grace for an undo accepted on the last second.
        val until = "2026-11-17T20:04:30.000Z"
        assertEquals(Decision.WAIT, UndoneDepartureTracking.decide(parked, "COMPLETED", until, now))
        assertEquals(
            Decision.DROP,
            UndoneDepartureTracking.decide(parked, "COMPLETED", until, now + UndoneDepartureTracking.PARK_GRACE_MS),
        )
    }

    @Test
    fun `with no window stamped the wait is still bounded`() {
        val late = parked.parkedAtMs + UndoneDepartureTracking.PARK_CAP_MS + 1
        assertEquals(Decision.DROP, UndoneDepartureTracking.decide(parked, "DEPARTED", null, late))
        assertEquals(Decision.DROP, UndoneDepartureTracking.decide(parked, "ARRIVED", null, late))
    }

    @Test
    fun `NEGATIVE - a visit cancelled or moved back is not an undone departure`() {
        for (s in listOf("CANCELLED", "SCHEDULED", "ON_MY_WAY")) {
            assertEquals(s, Decision.DROP, UndoneDepartureTracking.decide(parked, s, null, now))
        }
    }

    @Test
    fun `ERROR - an unreadable window is no window`() {
        assertNull(UndoneDepartureTracking.untilMs("not a date"))
        assertNull(UndoneDepartureTracking.untilMs(" "))
        assertEquals(Decision.WAIT, UndoneDepartureTracking.decide(parked, "COMPLETED", "not a date", now))
    }

    @Test
    fun `the resumed route keeps the first part, in time order, under the point cap`() {
        val crumbs = (0 until 10).map { LocationPoint(latitude = it.toDouble(), timestamp = 1_000L * (10 - it)) }
        val seeded = UndoneDepartureTracking.seedPoints(crumbs, maxPoints = 100)
        assertEquals(10, seeded.size)
        assertEquals(seeded.map { it.timestamp }.sorted(), seeded.map { it.timestamp })
        assertTrue(UndoneDepartureTracking.seedPoints(crumbs, maxPoints = 4).size <= 4)
    }

    @Test
    fun `the resumed route is the saved one, still open`() {
        val saved = VisitRoute(
            id = "route1",
            kinCareSessionId = "s1",
            kinfolkId = "kf1",
            startTime = "2026-11-17T19:00:00Z",
            arrivalTime = "2026-11-17T19:05:00Z",
            departureTime = "2026-11-17T20:00:00Z",
            endTime = "2026-11-17T20:00:00Z",
        )
        val r = UndoneDepartureTracking.resumedRoute(saved, "s1", "kf1", "2026-11-17T20:05:00Z")
        assertEquals("route1", r.id)
        assertEquals("2026-11-17T19:00:00Z", r.startTime)
        assertEquals("2026-11-17T19:05:00Z", r.arrivalTime)
        assertEquals("", r.departureTime)
        assertEquals("", r.endTime)
        // A route that could not be read starts a fresh shell for the same visit.
        val fresh = UndoneDepartureTracking.resumedRoute(null, "s1", "kf1", "2026-11-17T20:05:00Z")
        assertEquals("", fresh.id)
        assertEquals("s1", fresh.kinCareSessionId)
        // A failed read of a known route keeps its id: one visit_routes document, never two.
        val kept = UndoneDepartureTracking.resumedRoute(null, "s1", "kf1", "2026-11-17T20:05:00Z", "route1")
        assertEquals("route1", kept.id)
        assertEquals("route1", UndoneDepartureTracking.resumedRoute(saved.copy(id = ""), "s1", "kf1", "x", "route1").id)
    }

    private val chicago = ZoneId.of("America/Chicago")

    @Test
    fun `the card says live only when this phone is the tracker`() {
        val line = gpsLineFor(trackingHere = true, crumbs = null, zone = chicago)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }

    @Test
    fun `otherwise it says when the route last pinged, in 24 hours, with no live dot`() {
        val crumbs = listOf(LocationPoint(timestamp = now - 60_000), LocationPoint(timestamp = now))
        val line = gpsLineFor(trackingHere = false, crumbs = crumbs, zone = chicago)!!
        assertEquals("GPS route · last ping 14:05", line.text)
        assertFalse(line.live)
    }

    @Test
    fun `no pings yet, and nothing while loading`() {
        assertEquals("No GPS pings yet", gpsLineFor(false, emptyList(), chicago)?.text)
        assertNull(gpsLineFor(false, null, chicago))
    }

    @Test
    fun `#2339 - a step the household already heard about is not promised again`() {
        val routed = KinCareSession(id = "s1", kinfolkId = "kf1", kinCareBatchId = "b1", kinCareVisitId = "v1")
        assertEquals(
            "Dre East was already told the visit has finished, so they will not be told again.",
            visitNoticeConfirmLine(
                VisitNotifier.Event.DEPARTED,
                routed,
                VisitNoticeReach.Ready(willNotify = false, reason = "already_notified"),
                "Dre East",
            ),
        )
    }
}
