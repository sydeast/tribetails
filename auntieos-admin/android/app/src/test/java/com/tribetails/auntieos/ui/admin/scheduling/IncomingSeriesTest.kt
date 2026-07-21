package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.repository.IncomingKinCare
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
}
