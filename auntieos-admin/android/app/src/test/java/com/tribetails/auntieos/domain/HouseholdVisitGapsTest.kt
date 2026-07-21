package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.KinCareSession
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Gatekeeper widget: per-household days-since-last-completed-visit, longest gaps
 * first, so the operator catches households drifting toward a too-long gap.
 * Mirror of the web HouseholdVisitGapsTest.
 */
class HouseholdVisitGapsTest {

    private fun done(kinId: String, name: String, date: String, completedAt: String = "") =
        KinCareSession(
            kinfolkId = kinId,
            kinfolkName = name,
            startTime = date,
            completedAt = completedAt,
            status = "COMPLETED",
        )

    @Test
    fun groupsByHousehold_takesMostRecentVisit_sortsLongestGapFirst() {
        val sessions = listOf(
            done("a", "the Bs", "2026-06-10"),
            done("a", "the Bs", "2026-06-05"), // older visit for A is ignored
            done("b", "the Cs", "2026-06-20"),
        )
        val gaps = householdVisitGaps(sessions, "2026-06-23", limit = 5)
        assertEquals(
            listOf("the Bs" to 13, "the Cs" to 3),
            gaps.map { it.household to it.daysSinceLastVisit },
        )
    }

    @Test
    fun ignoresNonCompletedVisits() {
        val sessions = listOf(
            KinCareSession(kinfolkId = "a", kinfolkName = "the Bs", startTime = "2026-06-22", status = "SCHEDULED"),
        )
        assertEquals(emptyList<HouseholdGap>(), householdVisitGaps(sessions, "2026-06-23", limit = 5))
    }

    @Test
    fun respectsTheLimit() {
        val sessions = (1..8).map { done("k$it", "fam$it", "2026-06-0${if (it < 10) it else 9}") }
        assertEquals(3, householdVisitGaps(sessions, "2026-06-23", limit = 3).size)
    }

    @Test
    fun prefersCompletedAtOverStartTime() {
        val sessions = listOf(
            done("a", "the Bs", date = "2026-06-01", completedAt = "2026-06-21T14:30:00Z"),
        )
        val gaps = householdVisitGaps(sessions, "2026-06-23", limit = 5)
        assertEquals(listOf(HouseholdGap("the Bs", 2)), gaps)
    }

    @Test
    fun dropsFutureDatesAndUnparseableDates() {
        val sessions = listOf(
            done("a", "the Bs", "2026-07-01"), // future -> dropped
            done("b", "the Cs", "not-a-date"), // unparseable -> dropped
        )
        assertTrue(householdVisitGaps(sessions, "2026-06-23", limit = 5).isEmpty())
    }

    @Test
    fun unparseableTodayYieldsNothing() {
        val sessions = listOf(done("a", "the Bs", "2026-06-10"))
        assertTrue(householdVisitGaps(sessions, "junk", limit = 5).isEmpty())
    }

    @Test
    fun fallsBackToKinfolkNameWhenIdBlank() {
        val sessions = listOf(done("", "the Ds", "2026-06-20"))
        assertEquals(listOf(HouseholdGap("the Ds", 3)), householdVisitGaps(sessions, "2026-06-23", limit = 5))
    }
}
