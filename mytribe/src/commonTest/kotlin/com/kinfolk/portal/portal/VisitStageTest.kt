package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * #1830 / #1832 / #1823: one reading of where a visit stands at every status
 * of its life, the lookup a visit notice lands on, and the rule for keeping an
 * open screen current. The web portal's `portalFormat.visitStage.test.ts` pins
 * the same answers.
 *
 * #2123 (operator ruling 2026-11-12): a visit is Completed at departure. The
 * server sends a departed visit as completed, and an older answer that still
 * pairs `active` with `ended` reads Completed. There is no Departed stage.
 */
class VisitStageTest {
    private fun booking(
        id: String = "v1",
        status: BookingStatus = BookingStatus.Confirmed,
        progress: VisitProgress? = null,
        startTimeMs: Long? = null,
    ) = Booking(
        id = id,
        kinfolkId = "fam-1",
        status = status,
        serviceType = "visit_30",
        title = null,
        startTimeMs = startTimeMs,
        endTimeMs = null,
        kinIds = listOf("k1"),
        kinNames = listOf("Biscuit"),
        auntieDisplayName = "Maya",
        auntieAvatarUrl = null,
        notes = null,
        createdAtMs = null,
        visitProgress = progress,
        batchId = "b1",
    )

    /** Every stage, as the server sends it. */
    private val wire: List<Triple<VisitStage, BookingStatus, VisitProgress?>> = listOf(
        Triple(VisitStage.Requested, BookingStatus.Requested, null),
        Triple(VisitStage.Confirmed, BookingStatus.Confirmed, null),
        Triple(VisitStage.EnRoute, BookingStatus.EnRoute, VisitProgress.EnRoute),
        Triple(VisitStage.Active, BookingStatus.Active, VisitProgress.Active),
        // #2123: a departed visit in an answer from before the change.
        Triple(VisitStage.Completed, BookingStatus.Active, VisitProgress.Ended),
        Triple(VisitStage.Completed, BookingStatus.Completed, VisitProgress.Ended),
        Triple(VisitStage.Cancelled, BookingStatus.Cancelled, null),
    )

    private fun result(
        live: Booking? = null,
        upcoming: List<Booking> = emptyList(),
        recent: List<Booking> = emptyList(),
        envelopes: List<BookingEnvelope> = emptyList(),
    ) = BookingsResult(liveVisit = live, upcoming = upcoming, recent = recent, envelopes = envelopes)

    private fun envelope(vararg kinCares: Booking) = BookingEnvelope(
        batchId = "b1",
        envelopeStatus = EnvelopeStatus.Confirmed,
        pattern = "individual",
        serviceName = null,
        kinIds = emptyList(),
        kinNames = emptyList(),
        notes = null,
        visitCount = kinCares.size,
        confirmedCount = 0,
        completedCount = 0,
        firstStartTimeMs = null,
        lastStartTimeMs = null,
        kinCares = kinCares.toList(),
    )

    // -- stage --

    @Test
    fun `every status pair reads as its stage`() {
        wire.forEach { (stage, status, progress) ->
            assertEquals(stage, booking(status = status, progress = progress).stage(), "$status + $progress")
        }
    }

    @Test
    fun `an arrived visit from a server that sends no progress is still in progress`() {
        assertEquals(VisitStage.Active, booking(status = BookingStatus.Active, progress = null).stage())
    }

    @Test
    fun `every stage has one word, the same as the web portal`() {
        assertEquals(
            listOf("REQUESTED", "CONFIRMED", "EN ROUTE", "IN PROGRESS", "COMPLETED", "CANCELLED", "DECLINED"),
            VisitStage.entries.map { it.label() },
        )
    }

    @Test
    fun `under way is on the way or arrived, and a departed visit is finished`() {
        val underWay = wire.filter { (_, status, progress) -> booking(status = status, progress = progress).isUnderWay() }
        assertEquals(listOf(VisitStage.EnRoute, VisitStage.Active), underWay.map { it.first })
        val departed = booking(status = BookingStatus.Active, progress = VisitProgress.Ended)
        assertTrue(departed.isFinished())
        assertEquals("COMPLETED", departed.stage().label())
    }

    @Test
    fun `an arrived visit is not finished`() {
        assertFalse(booking(status = BookingStatus.Active, progress = VisitProgress.Active).isFinished())
        assertFalse(booking(status = BookingStatus.EnRoute, progress = VisitProgress.EnRoute).isFinished())
    }

    // -- the live card --

    @Test
    fun `the live visit is the one on the way or arrived`() {
        val otw = booking(status = BookingStatus.EnRoute, progress = VisitProgress.EnRoute)
        val here = booking(status = BookingStatus.Active, progress = VisitProgress.Active)
        assertSame(otw, result(live = otw).liveVisitOrNull())
        assertSame(here, result(live = here).liveVisitOrNull())
    }

    @Test
    fun `there is no live visit once it is departed, even if the answer still names it`() {
        val departed = booking(status = BookingStatus.Active, progress = VisitProgress.Ended)
        assertNull(result(live = departed).liveVisitOrNull())
        assertNull(result().liveVisitOrNull())
    }

    // -- by id --

    @Test
    fun `finds a listed visit at every status`() {
        wire.forEach { (stage, status, progress) ->
            val v = booking(status = status, progress = progress)
            val listed = if (v.isFinished()) result(recent = listOf(v)) else result(upcoming = listOf(v))
            assertSame(v, listed.findBooking("v1"), "$stage")
        }
    }

    @Test
    fun `finds a visit that is on no list through its envelope, at every status`() {
        wire.forEach { (stage, status, progress) ->
            val v = booking(status = status, progress = progress)
            val found = result(envelopes = listOf(envelope(booking(id = "other"), v))).findBooking("v1")
            assertSame(v, found, "$stage")
            assertEquals(stage, found?.stage())
        }
    }

    @Test
    fun `finds the live visit, and prefers a listed copy over the envelope copy`() {
        val live = booking(status = BookingStatus.Active, progress = VisitProgress.Active)
        assertSame(live, result(live = live).findBooking("v1"))
        val listed = booking(status = BookingStatus.EnRoute, progress = VisitProgress.EnRoute)
        val inEnvelope = booking(status = BookingStatus.Confirmed)
        assertSame(listed, result(upcoming = listOf(listed), envelopes = listOf(envelope(inEnvelope))).findBooking("v1"))
    }

    @Test
    fun `a visit of another household is in no answer the server gives, so it is not found`() {
        val mine = booking(id = "mine", status = BookingStatus.Active, progress = VisitProgress.Active)
        val answer = result(live = mine, upcoming = listOf(mine), envelopes = listOf(envelope(mine)))
        assertNull(answer.findBooking("theirs"))
        assertNull(result().findBooking("v1"))
    }

    // -- keeping a screen current --

    private val now = 1_800_000_000_000L
    private val min = 60_000L

    @Test
    fun `a visit under way is followed`() {
        wire.filter { (_, status, progress) -> booking(status = status, progress = progress).isUnderWay() }
            .forEach { (stage, status, progress) ->
                assertTrue(result(upcoming = listOf(booking(status = status, progress = progress))).isBeingFollowed(now), "$stage")
            }
    }

    @Test
    fun `a confirmed visit is followed from an hour before its start, to catch the first tap`() {
        assertTrue(result(upcoming = listOf(booking(startTimeMs = now + 59 * min))).isBeingFollowed(now))
        assertFalse(result(upcoming = listOf(booking(startTimeMs = now + 61 * min))).isBeingFollowed(now))
        // Running late: still the household's next visit.
        assertTrue(result(upcoming = listOf(booking(startTimeMs = now - 20 * min))).isBeingFollowed(now))
    }

    @Test
    fun `nothing is followed for a request, a finished visit, an empty schedule or no answer`() {
        assertFalse(result(upcoming = listOf(booking(status = BookingStatus.Requested, startTimeMs = now + min))).isBeingFollowed(now))
        assertFalse(result(recent = listOf(booking(status = BookingStatus.Completed, startTimeMs = now - min))).isBeingFollowed(now))
        // #2123: an older answer that still lists a departed visit as upcoming is not followed.
        assertFalse(
            result(upcoming = listOf(booking(status = BookingStatus.Active, progress = VisitProgress.Ended, startTimeMs = now + 2 * 60 * min)))
                .isBeingFollowed(now),
        )
        assertFalse(result().isBeingFollowed(now))
        assertFalse((null as BookingsResult?).isBeingFollowed(now))
    }

    // -- off the wire --

    private fun visitJson(id: String, status: String, progress: String?): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "fam-1")
        put("batchId", "b1")
        put("status", status)
        if (progress == null) put("visitProgress", JsonNull) else put("visitProgress", progress)
        put("sessionId", "vis_$id")
        put("kinNames", buildJsonArray { add("Biscuit") })
    }

    @Test
    fun `getMyBookings decodes each stage of a visit under way, in its list and in its envelope`() = runTest {
        val cases = listOf(
            Triple("enRoute", "enRoute", VisitStage.EnRoute),
            Triple("active", "active", VisitStage.Active),
            // #2123: what an older server sent for a departed visit, and what this one sends.
            Triple("active", "ended", VisitStage.Completed),
            Triple("completed", "ended", VisitStage.Completed),
        )
        cases.forEach { (status, progress, stage) ->
            val fake = FakeFunctionsClient()
            val v = visitJson("v1", status, progress)
            fake.stub("getMyBookings", buildJsonObject {
                put("liveVisit", if (stage == VisitStage.Completed) JsonNull else v)
                put("upcoming", buildJsonArray { add(v) })
                put("recent", buildJsonArray {})
                put("envelopes", buildJsonArray {
                    add(buildJsonObject {
                        put("batchId", "b1")
                        put("kinCares", buildJsonArray { add(v) })
                    })
                })
            })
            val res = PortalApi(fake).getMyBookings("fam-1")
            assertEquals(stage, res.upcoming.single().stage(), "$status + $progress, listed")
            assertEquals(stage, res.envelopes.single().kinCares.single().stage(), "$status + $progress, envelope")
            assertEquals(stage, res.findBooking("v1")?.stage())
            assertEquals(listOf("Biscuit"), res.findBooking("v1")?.kinNames)
            assertEquals(stage != VisitStage.Completed, res.liveVisitOrNull() != null)
        }
    }
}
