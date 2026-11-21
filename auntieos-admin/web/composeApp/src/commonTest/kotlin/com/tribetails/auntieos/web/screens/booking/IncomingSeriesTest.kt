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

    // ── #1577: whose request it is ──────────────────────────────────────────
    @Test
    fun theCardAndBothConfirmStepsNameTheHousehold() {
        val series = groupIncomingBySeries(
            listOf(
                visit("kf1", "b1", "v1", "2026-06-03T14:00:00Z", name = "The Rowans"),
                visit("kf1", "b1", "v2", "2026-06-10T14:00:00Z", name = "The Rowans"),
            ),
        ).single()
        assertEquals("The Rowans", series.householdLabel())
        assertEquals("2 visits · recurring series · Walk", series.subject())
        assertEquals("Book this request for The Rowans", series.approveConfirmTitle())
        assertEquals("Turn down this request from The Rowans", series.declineConfirmTitle())
        assertEquals("New request from The Rowans", series.detailTitle())
    }
    @Test
    fun aRequestWithNoHouseholdNameSaysSo() {
        val series = groupIncomingBySeries(listOf(visit("kf1", "b1", "v1", "2026-06-03T14:00:00Z"))).single()
        assertEquals(HOUSEHOLD_NOT_ON_FILE, series.householdLabel())
        assertEquals("Book this request", series.approveConfirmTitle())
    }
    @Test
    fun theDetailListsEveryVisitOnTheBusinessClock() {
        val series = groupIncomingBySeries(
            listOf(
                visit("kf1", "b1", "v1", "2026-06-03T14:00:00Z"),
                visit("kf1", "b1", "v2", ""),
                visit("kf1", "b1", "v3", "soon"),
            ),
        ).single()
        assertEquals(
            listOf("Time not on file", "Wed, Jun 3 at 9:00 AM", "soon"),
            series.visitLines(kotlinx.datetime.TimeZone.of("America/Chicago")),
        )
    }
}

/** #1870: Book it says who the request's visits are assigned to, never by email. */
class IncomingSeriesAssigneeTest {
    private fun series(vararg visits: KinCareVisit) = BookingSeries(
        batchId = "b1", kinfolkId = "kf1", kinfolkName = "The Wrens", serviceType = "Walk", visits = visits.toList(),
    )

    private val owner = com.tribetails.auntieos.web.data.StaffMember("u1", "e2e-admin@tribetails.com", "e2e-admin@tribetails.com", role = "owner")
    @Test
    fun namesTheStoredAssignee() {
        val s = series(KinCareVisit(_id = "v1", assignedAuntieUid = "u1", auntieDisplayName = "Auntie Ruth"))
        assertEquals("Assigned to Auntie Ruth.", s.acceptAssigneeLine(null))
    }

    @Test
    fun waitsOnTheRosterThenNeverShowsAnEmail() {
        val s = series(KinCareVisit(_id = "v1", assignedAuntieUid = "u1", auntieDisplayName = null))
        assertEquals(null, s.acceptAssigneeLine(null))
        assertEquals("Assigned to the Operator.", s.acceptAssigneeLine(listOf(owner)))
        assertEquals("Assigned to a staff member.", s.acceptAssigneeLine(emptyList()))
    }

    @Test
    fun saysWhenNobodyIsAssigned() {
        assertTrue(series(KinCareVisit(_id = "v1")).acceptAssigneeLine(null)!!.startsWith("No Auntie is assigned yet"))
    }

    @Test
    fun assignedRowNeverShowsAnEmail() {
        assertEquals("Unassigned", com.tribetails.auntieos.web.data.assignedAuntieLabel(null, null, null))
        assertEquals("Assigned", com.tribetails.auntieos.web.data.assignedAuntieLabel("u1", null, null))
        assertEquals("Operator", com.tribetails.auntieos.web.data.assignedAuntieLabel("u1", "e2e-admin@tribetails.com", listOf(owner)))
        assertEquals("Auntie Ruth", com.tribetails.auntieos.web.data.assignedAuntieLabel("u1", "Auntie Ruth", listOf(owner)))
    }
}
