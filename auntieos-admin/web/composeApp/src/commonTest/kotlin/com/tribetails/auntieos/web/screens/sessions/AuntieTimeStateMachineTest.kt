package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.Breadcrumb
import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Auntie Time (page-spec 14 item: "Integration-test each status transition + the
 * GPS start/stop side effects"). Covers the three pieces of screen logic that
 * decide what the operator's daily driver writes and does:
 *
 *   1. [kinCarePatch]          - the exact field set each transition writes
 *   2. [gpsEffectFor]          - tracker start/stop after a successful patch
 *   3. [isVisibleOnAuntieTime] - the day-of window filter
 *   4. [buildGpsSummary]       - distance/duration + route down-sampling
 */
class AuntieTimeStateMachineTest {

    private val now = "2026-07-21T14:30:00Z"

    private fun session(
        id: String = "s1",
        status: String = "SCHEDULED",
        startTime: String = "2026-07-21T09:00:00Z",
        onMyWayAt: String = "",
        arrivedAt: String = "",
    ) = KinCareSession(
        _id = id,
        status = status,
        startTime = startTime,
        onMyWayAt = onMyWayAt,
        arrivedAt = arrivedAt,
    )

    // ── 1. Status transitions: the exact field set written ────────────────────

    @Test
    fun `OMW writes ON_MY_WAY plus the onMyWayAt stamp and nothing else`() {
        val patch = kinCarePatch(session(status = "SCHEDULED"), AuntieTimeAction.OnMyWay, now)
        assertEquals(mapOf("status" to "ON_MY_WAY", "onMyWayAt" to now), patch)
    }

    @Test
    fun `Arrived writes ARRIVED plus the arrivedAt stamp and nothing else`() {
        val patch = kinCarePatch(session(status = "SCHEDULED"), AuntieTimeAction.Arrived, now)
        assertEquals(mapOf("status" to "ARRIVED", "arrivedAt" to now), patch)
    }

    @Test
    fun `Arrived from ON_MY_WAY writes the same patch as Arrived from SCHEDULED`() {
        // Both the SCHEDULED row and the ON_MY_WAY row expose an "Arrived" button;
        // they must not diverge. Notably neither clears onMyWayAt.
        val fromScheduled = kinCarePatch(session(status = "SCHEDULED"), AuntieTimeAction.Arrived, now)
        val fromOmw = kinCarePatch(
            session(status = "ON_MY_WAY", onMyWayAt = "2026-07-21T14:00:00Z"),
            AuntieTimeAction.Arrived,
            now,
        )
        assertEquals(fromScheduled, fromOmw)
        assertTrue("onMyWayAt" !in fromOmw, "Arrived must not touch onMyWayAt")
    }

    @Test
    fun `Departed writes DEPARTED plus the departedAt stamp and nothing else`() {
        val patch = kinCarePatch(session(status = "ARRIVED"), AuntieTimeAction.Departed, now)
        assertEquals(mapOf("status" to "DEPARTED", "departedAt" to now), patch)
        assertTrue("arrivedAt" !in patch, "Departed must preserve the recorded arrival")
    }

    @Test
    fun `Undo Arrived rewinds to ON_MY_WAY when onMyWayAt is set`() {
        val patch = kinCarePatch(
            session(status = "ARRIVED", onMyWayAt = "2026-07-21T14:00:00Z", arrivedAt = "2026-07-21T14:20:00Z"),
            AuntieTimeAction.UndoArrived,
            now,
        )
        assertEquals("ON_MY_WAY", patch["status"])
    }

    @Test
    fun `Undo Arrived rewinds to SCHEDULED when onMyWayAt is blank`() {
        // The operator tapped Arrived straight off a SCHEDULED card, so there is
        // no on-my-way leg to fall back to.
        val patch = kinCarePatch(
            session(status = "ARRIVED", onMyWayAt = "", arrivedAt = "2026-07-21T14:20:00Z"),
            AuntieTimeAction.UndoArrived,
            now,
        )
        assertEquals("SCHEDULED", patch["status"])
    }

    @Test
    fun `Undo Arrived always clears arrivedAt and writes only those two fields`() {
        val withOmw = kinCarePatch(
            session(status = "ARRIVED", onMyWayAt = "2026-07-21T14:00:00Z"),
            AuntieTimeAction.UndoArrived,
            now,
        )
        val withoutOmw = kinCarePatch(session(status = "ARRIVED"), AuntieTimeAction.UndoArrived, now)

        assertEquals(mapOf("status" to "ON_MY_WAY", "arrivedAt" to ""), withOmw)
        assertEquals(mapOf("status" to "SCHEDULED", "arrivedAt" to ""), withoutOmw)
        // Undo must never stamp the clock onto the doc.
        assertTrue(withOmw.values.none { it == now })
    }

    @Test
    fun `Undo Arrived treats whitespace-only onMyWayAt as absent`() {
        val patch = kinCarePatch(
            session(status = "ARRIVED", onMyWayAt = "   "),
            AuntieTimeAction.UndoArrived,
            now,
        )
        assertEquals("SCHEDULED", patch["status"])
    }

    @Test
    fun `kebab Mark Completed writes COMPLETED plus completedAt`() {
        val patch = kinCarePatch(session(status = "ARRIVED"), AuntieTimeAction.MarkCompleted, now)
        assertEquals(mapOf("status" to "COMPLETED", "completedAt" to now), patch)
    }

    @Test
    fun `kebab Cancel writes only the status, no timestamp`() {
        val patch = kinCarePatch(session(status = "SCHEDULED"), AuntieTimeAction.Cancel, now)
        assertEquals(mapOf("status" to "CANCELLED"), patch)
    }

    @Test
    fun `every transition writes a status and only UndoArrived depends on the session`() {
        AuntieTimeAction.entries.forEach { action ->
            val patch = kinCarePatch(session(), action, now)
            assertTrue(patch.containsKey("status"), "$action wrote no status")
            assertTrue(patch["status"]!!.isNotBlank(), "$action wrote a blank status")
        }
        // Only UndoArrived reads session state; the rest are session-independent.
        val a = session(id = "a", onMyWayAt = "")
        val b = session(id = "b", onMyWayAt = "2026-07-21T14:00:00Z")
        AuntieTimeAction.entries
            .filter { it != AuntieTimeAction.UndoArrived }
            .forEach { action ->
                assertEquals(kinCarePatch(a, action, now), kinCarePatch(b, action, now), "$action must ignore session state")
            }
    }

    @Test
    fun `success messages are distinct and non-blank`() {
        val msgs = AuntieTimeAction.entries.map { kinCareSuccessMessage(it) }
        assertTrue(msgs.none { it.isBlank() })
        assertEquals(msgs.size, msgs.toSet().size, "toast copy must be distinguishable")
        assertEquals("Arrived. GPS started.", kinCareSuccessMessage(AuntieTimeAction.Arrived))
        assertEquals("Departed. GPS saved.", kinCareSuccessMessage(AuntieTimeAction.Departed))
    }

    // ── 2. GPS side effects fired after a successful patch ────────────────────

    @Test
    fun `ARRIVED is the only status that starts the tracker`() {
        assertEquals(GpsEffect.Start, gpsEffectFor(mapOf("status" to "ARRIVED")))
        listOf("DEPARTED", "ON_MY_WAY", "SCHEDULED", "COMPLETED", "CANCELLED").forEach {
            assertEquals(GpsEffect.Stop, gpsEffectFor(mapOf("status" to it)), "$it should stop GPS")
        }
    }

    @Test
    fun `gps effect is case-insensitive on the patch status`() {
        assertEquals(GpsEffect.Start, gpsEffectFor(mapOf("status" to "arrived")))
        assertEquals(GpsEffect.Stop, gpsEffectFor(mapOf("status" to "departed")))
    }

    @Test
    fun `a patch with no status leaves the tracker alone`() {
        assertEquals(GpsEffect.None, gpsEffectFor(emptyMap()))
        assertEquals(GpsEffect.None, gpsEffectFor(mapOf("notes" to "fed the cat")))
        assertEquals(GpsEffect.None, gpsEffectFor(mapOf("status" to "DRAFT")))
    }

    @Test
    fun `each transition pairs with the right tracker effect end to end`() {
        fun effect(s: KinCareSession, a: AuntieTimeAction) = gpsEffectFor(kinCarePatch(s, a, now))
        val scheduled = session(status = "SCHEDULED")
        val arrived   = session(status = "ARRIVED", onMyWayAt = "2026-07-21T14:00:00Z")

        assertEquals(GpsEffect.Stop,  effect(scheduled, AuntieTimeAction.OnMyWay))
        assertEquals(GpsEffect.Start, effect(scheduled, AuntieTimeAction.Arrived))
        assertEquals(GpsEffect.Stop,  effect(arrived, AuntieTimeAction.Departed))
        // Undo Arrived must stop tracking whichever way it rewinds.
        assertEquals(GpsEffect.Stop,  effect(arrived, AuntieTimeAction.UndoArrived))
        assertEquals(GpsEffect.Stop,  effect(session(status = "ARRIVED"), AuntieTimeAction.UndoArrived))
        assertEquals(GpsEffect.Stop,  effect(arrived, AuntieTimeAction.MarkCompleted))
        assertEquals(GpsEffect.Stop,  effect(arrived, AuntieTimeAction.Cancel))
    }

    // ── 3. Day-of window filter ───────────────────────────────────────────────

    private val today = "2026-07-21"

    @Test
    fun `in-flight sessions are visible regardless of date`() {
        listOf("ON_MY_WAY", "ARRIVED", "DEPARTED").forEach { status ->
            listOf("2019-01-01T09:00:00Z", "2026-07-21T09:00:00Z", "2099-12-31T09:00:00Z", "").forEach { start ->
                assertTrue(
                    isVisibleOnAuntieTime(session(status = status, startTime = start), today),
                    "$status starting '$start' must stay on screen",
                )
            }
        }
    }

    @Test
    fun `SCHEDULED 14 days out is in, 15 days out is excluded`() {
        assertTrue(isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2026-08-04T09:00:00Z"), today))
        assertTrue(!isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2026-08-05T09:00:00Z"), today))
    }

    @Test
    fun `SCHEDULED yesterday is in, two days ago is excluded`() {
        assertTrue(isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2026-07-20T09:00:00Z"), today))
        assertTrue(!isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2026-07-19T09:00:00Z"), today))
    }

    @Test
    fun `SCHEDULED today is in`() {
        assertTrue(isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2026-07-21T00:00:00Z"), today))
    }

    @Test
    fun `COMPLETED yesterday is in, last week is out`() {
        assertTrue(isVisibleOnAuntieTime(session(status = "COMPLETED", startTime = "2026-07-20T09:00:00Z"), today))
        assertTrue(!isVisibleOnAuntieTime(session(status = "COMPLETED", startTime = "2026-07-14T09:00:00Z"), today))
    }

    @Test
    fun `CANCELLED follows the same since-yesterday rule as COMPLETED`() {
        assertTrue(isVisibleOnAuntieTime(session(status = "CANCELLED", startTime = "2026-07-20T09:00:00Z"), today))
        assertTrue(!isVisibleOnAuntieTime(session(status = "CANCELLED", startTime = "2026-07-14T09:00:00Z"), today))
    }

    @Test
    fun `COMPLETED far in the future is still visible (no upper bound by design)`() {
        // The terminal-status branch is "date >= yesterday" with no cutoff, unlike
        // SCHEDULED. Pinning it so a future change to the branch is deliberate.
        assertTrue(isVisibleOnAuntieTime(session(status = "COMPLETED", startTime = "2027-01-01T09:00:00Z"), today))
    }

    @Test
    fun `DRAFT and PENDING are dropped by design (AO-60)`() {
        // Documented behaviour, not a bug to fix here: a booking reaches Auntie
        // Time only after it is approved to SCHEDULED. The Bookings screen owns
        // the DRAFT/PENDING queue and the empty state explains this.
        listOf("DRAFT", "PENDING", "REJECTED", "", "WAT").forEach { status ->
            assertTrue(
                !isVisibleOnAuntieTime(session(status = status, startTime = "2026-07-21T09:00:00Z"), today),
                "$status must not appear on Auntie Time",
            )
        }
    }

    @Test
    fun `status matching is case-insensitive`() {
        assertTrue(isVisibleOnAuntieTime(session(status = "arrived", startTime = "2019-01-01T09:00:00Z"), today))
        assertTrue(isVisibleOnAuntieTime(session(status = "scheduled", startTime = "2026-07-21T09:00:00Z"), today))
    }

    @Test
    fun `the window rolls correctly across a month and year boundary`() {
        // today = Dec 31 -> yesterday Dec 30, cutoff Jan 14 next year.
        val nye = "2026-12-31"
        assertTrue(isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2026-12-30T09:00:00Z"), nye))
        assertTrue(isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2027-01-14T09:00:00Z"), nye))
        assertTrue(!isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2027-01-15T09:00:00Z"), nye))
        assertTrue(!isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = "2026-12-29T09:00:00Z"), nye))
    }

    @Test
    fun `a SCHEDULED session with no startTime is excluded`() {
        // "" never falls inside yesterday..cutoff, so undated scheduled rows stay
        // off the day-of view rather than pinning to the top.
        assertTrue(!isVisibleOnAuntieTime(session(status = "SCHEDULED", startTime = ""), today))
    }

    // ── 4. buildGpsSummary ────────────────────────────────────────────────────

    private fun crumb(lat: Double, lng: Double, ts: String) =
        Breadcrumb(_id = ts, timestamp = ts, lat = lat, lng = lng)

    /** [n] crumbs one second apart, walking north so every point is distinct. */
    private fun trail(n: Int): List<Breadcrumb> = (0 until n).map { i ->
        val h = i / 3600
        val m = (i % 3600) / 60
        val s = i % 60
        fun p(v: Int) = v.toString().padStart(2, '0')
        crumb(30.0 + i * 0.00001, -97.0, "2026-07-21T${p(h)}:${p(m)}:${p(s)}Z")
    }

    @Test
    fun `empty breadcrumbs produce an empty summary, not a crash`() {
        val summary = buildGpsSummary(emptyList())
        assertEquals(0.0, summary.distanceMeters)
        assertEquals(0L, summary.durationSeconds)
        assertTrue(summary.route.isEmpty())
        assertEquals(0.0, summary.startLat)
        assertEquals(0.0, summary.endLng)
        assertTrue(summary.computedAt.isNotBlank(), "computedAt must still be stamped")
    }

    @Test
    fun `a single breadcrumb yields zero distance and duration with start equal to end`() {
        val summary = buildGpsSummary(listOf(crumb(30.5, -97.5, "2026-07-21T10:00:00Z")))
        assertEquals(0.0, summary.distanceMeters)
        assertEquals(0L, summary.durationSeconds)
        assertEquals(30.5, summary.startLat)
        assertEquals(30.5, summary.endLat)
        assertEquals(-97.5, summary.startLng)
        assertEquals(-97.5, summary.endLng)
        assertEquals(1, summary.route.size)
    }

    @Test
    fun `distance sums consecutive haversine legs`() {
        // 0.001 deg of latitude is ~111.19 m; three collinear points -> ~222.39 m.
        val summary = buildGpsSummary(
            listOf(
                crumb(30.000, -97.0, "2026-07-21T10:00:00Z"),
                crumb(30.001, -97.0, "2026-07-21T10:10:00Z"),
                crumb(30.002, -97.0, "2026-07-21T10:20:00Z"),
            ),
        )
        assertTrue(
            abs(summary.distanceMeters - 222.39) < 0.5,
            "expected ~222.39 m, got ${summary.distanceMeters}",
        )
    }

    @Test
    fun `duration is first-to-last in whole seconds`() {
        val summary = buildGpsSummary(
            listOf(
                crumb(30.0, -97.0, "2026-07-21T10:00:00Z"),
                crumb(30.0, -97.0, "2026-07-21T10:12:34Z"),
                crumb(30.0, -97.0, "2026-07-21T10:30:00Z"),
            ),
        )
        assertEquals(1800L, summary.durationSeconds)
    }

    @Test
    fun `endpoints come from the first and last crumb`() {
        val summary = buildGpsSummary(
            listOf(
                crumb(30.1, -97.1, "2026-07-21T10:00:00Z"),
                crumb(30.2, -97.2, "2026-07-21T10:05:00Z"),
                crumb(30.3, -97.3, "2026-07-21T10:10:00Z"),
            ),
        )
        assertEquals(30.1, summary.startLat)
        assertEquals(-97.1, summary.startLng)
        assertEquals(30.3, summary.endLat)
        assertEquals(-97.3, summary.endLng)
    }

    @Test
    fun `route points carry epoch millis parsed from the crumb timestamp`() {
        val summary = buildGpsSummary(listOf(crumb(30.0, -97.0, "2026-07-21T10:00:00Z")))
        assertEquals(1_784_628_000_000L, summary.route.single().t)
    }

    @Test
    fun `an unparseable timestamp maps to t = 0 rather than throwing`() {
        val summary = buildGpsSummary(
            listOf(
                crumb(30.0, -97.0, ""),
                crumb(30.1, -97.0, "garbage"),
            ),
        )
        assertEquals(listOf(0L, 0L), summary.route.map { it.t })
        assertEquals(0L, summary.durationSeconds, "unknown clock must not fabricate a duration")
    }

    @Test
    fun `a short trail is passed through without down-sampling`() {
        val crumbs = trail(500)
        val summary = buildGpsSummary(crumbs)
        assertEquals(500, summary.route.size)
        assertEquals(crumbs.first().lat, summary.route.first().lat)
        assertEquals(crumbs.last().lat, summary.route.last().lat)
    }

    @Test
    fun `exactly 1000 crumbs are kept verbatim`() {
        assertEquals(1000, buildGpsSummary(trail(1000)).route.size)
    }

    @Test
    fun `down-sampling preserves the first and last fix`() {
        val crumbs = trail(2500)
        val summary = buildGpsSummary(crumbs)
        assertEquals(crumbs.first().lat, summary.route.first().lat, "route must start where Auntie started")
        assertEquals(crumbs.last().lat, summary.route.last().lat, "route must end where Auntie finished")
    }

    @Test
    fun `down-sampling keeps the route in chronological order`() {
        val ts = buildGpsSummary(trail(2500)).route.map { it.t }
        assertEquals(ts.sorted(), ts, "down-sampled route must stay time-ordered")
        assertEquals(ts.distinct().size, ts.size, "down-sampled route must not duplicate fixes")
    }

    @Test
    fun `down-sampling keeps distance and duration computed on the FULL series`() {
        // The whole point of down-sampling only the polyline: stats stay accurate.
        val crumbs = trail(2500)
        val summary = buildGpsSummary(crumbs)
        assertEquals(2499L, summary.durationSeconds)
        // 2499 legs of 0.00001 deg latitude each (~1.1119 m) -> ~2778 m.
        assertTrue(
            abs(summary.distanceMeters - 2778.0) < 5.0,
            "expected ~2778 m over the full series, got ${summary.distanceMeters}",
        )
    }

    @Test
    fun `down-sampling honours its documented 1000-point cap`() {
        // Regression guard for AO-GPS1: the loop used to fill exactly `target`
        // samples and THEN append the final crumb, returning 1001 for every input
        // over the cap and quietly breaking the "<= 1_000" contract. Fixed by
        // reserving the tail slot (fill to target - 1).
        listOf(1001, 1500, 2500, 10_000).forEach { n ->
            assertEquals(1000, buildGpsSummary(trail(n)).route.size, "n=$n")
        }
    }
    @Test
    fun `down-sampling still ends on the real final crumb`() {
        // The cap must not be bought by dropping the endpoint: the polyline has
        // to finish where Auntie actually finished.
        val crumbs = trail(2500)
        val route = buildGpsSummary(crumbs).route
        assertEquals(crumbs.last().lat, route.last().lat)
        assertEquals(crumbs.last().lng, route.last().lng)
    }
}
