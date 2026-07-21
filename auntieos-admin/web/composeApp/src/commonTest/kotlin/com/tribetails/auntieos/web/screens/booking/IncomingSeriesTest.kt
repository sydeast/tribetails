package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.KinCareVisit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Stage 3 / 16.5 (web): pure grouping of incoming kinCares into envelope series. */
class IncomingSeriesTest {

    private fun visit(fid: String, batch: String, visit: String, start: String, name: String = "") = KinCareVisit(
        _id = visit,
        path = "families/$fid/bookings/$batch/kinCares/$visit",
        kinfolkName = name,
        serviceType = "Walk",
        startTime = start,
        status = "requested",
    )

    @Test
    fun groupsByBatch_sorts_andSeriesFlag() {
        val list = listOf(
            visit("kf1", "b1", "v2", "2026-06-10T09:00:00"),
            visit("kf1", "b1", "v1", "2026-06-03T09:00:00"),
            visit("kf2", "b2", "v9", "2026-06-04T09:00:00"),
        )
        val groups = groupIncomingBySeries(list)
        assertEquals(2, groups.size)
        val b1 = groups.first { it.batchId == "b1" }
        assertEquals(2, b1.visitCount)
        assertTrue(b1.isSeries)
        assertEquals(listOf("v1", "v2"), b1.visits.map { it._id })
        assertEquals("kf1", b1.kinfolkId)
        assertFalse(groups.first { it.batchId == "b2" }.isSeries)
    }

    @Test
    fun resolvesNameFromDirectory_whenChildBlank() {
        val list = listOf(visit("kf1", "b1", "v1", "2026-06-03T09:00:00", name = ""))
        val groups = groupIncomingBySeries(list) { if (it == "kf1") "The Fenwick" else null }
        assertEquals("The Fenwick", groups.single().kinfolkName)
    }

    @Test
    fun dropsMalformedPath() {
        val bad = KinCareVisit(_id = "x", path = "garbage", startTime = "2026-06-01T09:00:00")
        assertTrue(groupIncomingBySeries(listOf(bad)).isEmpty())
    }

    @Test
    fun ordersGroupsByEarliestVisit() {
        val list = listOf(
            visit("kf1", "late", "v1", "2026-07-01T09:00:00"),
            visit("kf1", "early", "v1", "2026-06-01T09:00:00"),
        )
        assertEquals(listOf("early", "late"), groupIncomingBySeries(list).map { it.batchId })
    }

    // A batchId is unique only WITHIN a kinfolk. If two kinfolk share one (legacy
    // import / id collision), they must stay separate series, never merged under a
    // single kinfolkId (which would approve one kinfolk's visits under another).
    @Test
    fun doesNotMergeSameBatchIdAcrossKinfolk() {
        val list = listOf(
            visit("kf1", "b1", "v1", "2026-06-03T09:00:00"),
            visit("kf2", "b1", "v2", "2026-06-04T09:00:00"),
        )
        val groups = groupIncomingBySeries(list)
        assertEquals(2, groups.size)
        assertEquals(setOf("kf1", "kf2"), groups.map { it.kinfolkId }.toSet())
        groups.forEach { assertEquals(1, it.visitCount) }
    }
}
