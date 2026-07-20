package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.home.householdVisitGaps
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Gatekeeper widget: per-household days-since-last-completed-visit, longest gaps first,
 * so the operator catches households drifting toward a too-long gap.
 */
class HouseholdVisitGapsTest {

    private fun done(kinId: String, name: String, date: String) =
        KinCareSession(kinfolkId = kinId, kinfolkName = name, startTime = date, status = "COMPLETED")

    @Test
    fun `groups by household, takes the most recent completed visit, sorts longest-gap first`() {
        val sessions = listOf(
            done("a", "the Bs", "2026-06-10"),
            done("a", "the Bs", "2026-06-05"), // older visit for A is ignored
            done("b", "the Cs", "2026-06-20"),
        )
        val gaps = householdVisitGaps(sessions, "2026-06-23", limit = 5)
        assertEquals(listOf("the Bs" to 13, "the Cs" to 3), gaps.map { it.household to it.daysSinceLastVisit })
    }

    @Test
    fun `ignores non-completed visits`() {
        val sessions = listOf(
            KinCareSession(kinfolkId = "a", kinfolkName = "the Bs", startTime = "2026-06-22", status = "SCHEDULED"),
        )
        assertEquals(emptyList(), householdVisitGaps(sessions, "2026-06-23", limit = 5))
    }

    @Test
    fun `respects the limit`() {
        val sessions = (1..8).map { done("k$it", "fam$it", "2026-06-0${if (it < 10) it else 9}") }
        assertEquals(3, householdVisitGaps(sessions, "2026-06-23", limit = 3).size)
    }
}
