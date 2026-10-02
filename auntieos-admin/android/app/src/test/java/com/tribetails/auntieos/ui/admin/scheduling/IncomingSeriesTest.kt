package com.tribetails.auntieos.ui.admin.scheduling

import com.google.firebase.Timestamp
import com.tribetails.auntieos.data.repository.IncomingKinCare
import com.tribetails.auntieos.data.repository.incomingKinCareOf
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Stage 3 / 16.5: pure grouping of the incoming queue into per-envelope series. */
class IncomingSeriesTest {

    private fun ikc(batch: String, visit: String, start: String, fam: String = "kf1") = IncomingKinCare(
        familyId = fam, batchId = batch, visitId = visit, kinfolkId = fam,
        kinfolkName = "Jane Doe", serviceType = "Walk", startTime = start, endTime = "", status = "requested",
    )

    @Test
    fun groupsByBatch_sortsVisits_andSeriesFlag() {
        val list = listOf(
            ikc("b1", "v2", "2026-06-10T09:00:00"),
            ikc("b1", "v1", "2026-06-03T09:00:00"),
            ikc("b2", "v9", "2026-06-04T09:00:00"),
        )
        val groups = groupIncomingBySeries(list)
        assertEquals(2, groups.size)
        val b1 = groups.first { it.batchId == "b1" }
        assertEquals(2, b1.visitCount)
        assertTrue(b1.isSeries)
        // visits sorted ascending by startTime
        assertEquals(listOf("v1", "v2"), b1.visits.map { it.visitId })
        assertEquals("kf1", b1.kinfolkId)
        val b2 = groups.first { it.batchId == "b2" }
        assertFalse(b2.isSeries)
        assertEquals(1, b2.visitCount)
    }

    @Test
    fun ordersGroupsByEarliestVisit() {
        val list = listOf(
            ikc("late", "v1", "2026-07-01T09:00:00"),
            ikc("early", "v1", "2026-06-01T09:00:00"),
        )
        assertEquals(listOf("early", "late"), groupIncomingBySeries(list).map { it.batchId })
    }

    @Test
    fun dropsBlankBatch() {
        val list = listOf(ikc("", "v1", "2026-06-01T09:00:00"))
        assertTrue(groupIncomingBySeries(list).isEmpty())
    }

    @Test
    fun kinfolkIdFallsBackToFamilyId() {
        val raw = IncomingKinCare(familyId = "famX", batchId = "b", visitId = "v", kinfolkId = "", startTime = "2026-06-01T09:00:00")
        assertEquals("famX", groupIncomingBySeries(listOf(raw)).single().kinfolkId)
    }

    // A batchId is unique only WITHIN a kinfolk. If two kinfolk share one (legacy
    // import / id collision), they must stay separate series, never merged under a
    // single kinfolkId (which would approve one kinfolk's visits under another).
    @Test
    fun doesNotMergeSameBatchIdAcrossKinfolk() {
        val list = listOf(
            ikc("b1", "v1", "2026-06-03T09:00:00", fam = "kf1"),
            ikc("b1", "v2", "2026-06-04T09:00:00", fam = "kf2"),
        )
        val groups = groupIncomingBySeries(list)
        assertEquals(2, groups.size)
        assertEquals(setOf("kf1", "kf2"), groups.map { it.kinfolkId }.toSet())
        groups.forEach { assertEquals(1, it.visitCount) }
    }

    // ── #1098: an Overnight is requested as a NIGHT, and the operator sets its start ──

    private fun night(visit: String, date: String, fam: String = "kf1", batch: String = "b1") = IncomingKinCare(
        familyId = fam, batchId = batch, visitId = visit, kinfolkId = fam,
        kinfolkName = "Jane Doe", serviceType = "Overnight", serviceId = "Overnight",
        startTime = "", endTime = "", status = "requested",
        startTimePending = true, requestedDate = date,
    )

    @Test
    fun decodesAPendingNightFromTheVisitDoc() {
        val decoded = incomingKinCareOf(
            path = "families/kf1/bookings/b1/kinCares/v1",
            visitId = "v1",
            data = mapOf(
                "kinfolkId" to "kf1",
                "serviceType" to "Overnight",
                "serviceId" to "svc-overnight",
                "startTime" to null,
                "startTimePending" to true,
                "requestedDate" to "2026-10-09",
                "status" to "requested",
            ),
        )!!
        assertTrue(decoded.startTimePending)
        assertEquals("2026-10-09", decoded.requestedDate)
        assertEquals("svc-overnight", decoded.serviceId)
        assertEquals("", decoded.startTime)
        assertEquals("b1", decoded.batchId)
        assertEquals("kf1", decoded.familyId)
    }

    @Test
    fun decodesATimedVisitWithNoPendingFieldsAsNotPending() {
        val decoded = incomingKinCareOf(
            path = "families/kf1/bookings/b1/kinCares/v1",
            visitId = "v1",
            data = mapOf(
                "serviceType" to "Walk",
                "startTime" to Timestamp(1_790_000_000L, 0),
                "status" to "requested",
            ),
        )!!
        assertFalse(decoded.startTimePending)
        assertEquals("", decoded.requestedDate)
        assertEquals("", decoded.serviceId)
        assertEquals(Instant.ofEpochSecond(1_790_000_000L).toString(), decoded.startTime)
        assertEquals("kf1", decoded.kinfolkId)
    }

    @Test
    fun decodeDropsAPathWithNoBatch() {
        assertNull(incomingKinCareOf("families/kf1", "v1", emptyMap()))
    }

    @Test
    fun aPendingNightSortsByItsDateNotToTheFront() {
        val list = listOf(
            ikc("b1", "timed", "2026-10-08T15:00:00Z"),
            night("n1", "2026-10-09"),
        )
        assertEquals(listOf("timed", "n1"), groupIncomingBySeries(list).single().visits.map { it.visitId })
    }

    @Test
    fun aSeriesWithANightIsNotReadyUntilEveryNightHasATime() {
        val series = groupIncomingBySeries(listOf(night("n1", "2026-10-09"), night("n2", "2026-10-10"))).single()
        assertEquals(listOf("n1", "n2"), series.pendingNights.map { it.visitId })
        assertFalse(seriesReadyToApprove(series, emptyMap()))
        val one = mapOf(seriesNightKey(series, "n1") to LocalTime.of(19, 30))
        assertFalse(seriesReadyToApprove(series, one))
        val both = one + (seriesNightKey(series, "n2") to LocalTime.of(20, 0))
        assertTrue(seriesReadyToApprove(series, both))
    }

    @Test
    fun aSeriesWithNoNightIsAlwaysReady() {
        val series = groupIncomingBySeries(listOf(ikc("b1", "v1", "2026-06-03T09:00:00"))).single()
        assertTrue(series.pendingNights.isEmpty())
        assertTrue(seriesReadyToApprove(series, emptyMap()))
    }

    @Test
    fun startTimesAreReadOnTheNightInTheBusinessZone() {
        val series = groupIncomingBySeries(listOf(night("n1", "2026-10-09"))).single()
        val picks = mapOf(seriesNightKey(series, "n1") to LocalTime.of(19, 30))
        // 7:30 PM on Oct 9 in Chicago (CDT, UTC-5) is 00:30 UTC on Oct 10.
        assertEquals(
            mapOf("n1" to Instant.parse("2026-10-10T00:30:00Z").toEpochMilli()),
            seriesStartTimesMs(series, picks, ZoneId.of("America/Chicago")),
        )
        // The same wall clock in Tokyo is a different instant: the zone is what decides it.
        assertEquals(
            mapOf("n1" to Instant.parse("2026-10-09T10:30:00Z").toEpochMilli()),
            seriesStartTimesMs(series, picks, ZoneId.of("Asia/Tokyo")),
        )
    }

    @Test
    fun startTimesAreNullWhileANightIsUnset() {
        val series = groupIncomingBySeries(listOf(night("n1", "2026-10-09"))).single()
        assertNull(seriesStartTimesMs(series, emptyMap(), ZoneId.of("America/Chicago")))
    }

    @Test
    fun theBusinessZoneFallsBackToTheServerDefaultNeverTheDevice() {
        assertEquals(ZoneId.of("America/Chicago"), businessZoneOf(" America/Chicago "))
        assertEquals(ZoneId.of("America/Los_Angeles"), businessZoneOf("America/Los_Angeles"))
        // #1109: a missing or unreadable zone is the same America/Chicago the server resolves to.
        assertEquals(ZoneId.of("America/Chicago"), businessZoneOf(""))
        assertEquals(ZoneId.of("America/Chicago"), businessZoneOf("   "))
        assertEquals(ZoneId.of("America/Chicago"), businessZoneOf("Not/AZone"))
    }
    @Test
    fun aNightWithNoStoredZoneIsReadInChicagoRegardlessOfTheDevice() {
        val series = groupIncomingBySeries(listOf(night("n1", "2026-10-09"))).single()
        val picks = mapOf(seriesNightKey(series, "n1") to LocalTime.of(19, 30))
        val saved = java.util.TimeZone.getDefault()
        try {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("Asia/Tokyo"))
            assertEquals(
                mapOf("n1" to Instant.parse("2026-10-10T00:30:00Z").toEpochMilli()),
                seriesStartTimesMs(series, picks, businessZoneOf("")),
            )
        } finally {
            java.util.TimeZone.setDefault(saved)
        }
    }

    @Test
    fun namesTheNightAsItsDate() {
        assertEquals("Fri, Oct 9", nightLabel("2026-10-09"))
        assertEquals("soon", nightLabel("soon"))
    }
}
