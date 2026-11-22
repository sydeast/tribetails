package com.kinfolk.portal.screens.schedule

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.VisitStage
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #1870: an upcoming visit with a nameless staff member assigned read as if nobody had it. */
class AuntieAssignedTileTest {
    @Test
    fun anAssignedVisitWithNoNameReadsYourAuntie() {
        assertEquals("Your Auntie", auntieTileLabel(null, VisitStage.Confirmed, assigned = true))
        assertEquals("Your Auntie", auntieTileLabel("  ", VisitStage.Requested, assigned = true))
        assertEquals("Your Auntie", auntieTileLabel(null, VisitStage.EnRoute, assigned = true))
    }

    @Test
    fun aNameAlwaysWins() {
        assertEquals("Maya", auntieTileLabel("Maya", VisitStage.Confirmed, assigned = true))
    }

    @Test
    fun declinedCancelledAndUnassignedKeepTheirWords() {
        assertEquals("Not assigned", auntieTileLabel(null, VisitStage.Declined, assigned = true))
        assertEquals("Pending", auntieTileLabel(null, VisitStage.Cancelled, assigned = true))
        assertEquals("Pending", auntieTileLabel(null, VisitStage.Confirmed, assigned = false))
    }

    private fun bookingsWith(assigned: Boolean?) = buildJsonObject {
        put("liveVisit", JsonNull)
        put("upcoming", buildJsonArray {
            add(buildJsonObject {
                put("id", "v1")
                put("kinfolkId", "3")
                put("status", "confirmed")
                assigned?.let { put("auntieAssigned", it) }
            })
        })
        put("recent", buildJsonArray {})
    }

    @Test
    fun theFlagIsDecoded() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", bookingsWith(assigned = true))
        assertTrue(PortalApi(fake).getMyBookings().upcoming.single().auntieAssigned)
    }

    @Test
    fun anOlderServerWithNoFlagReadsAsNotAssigned() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", bookingsWith(assigned = null))
        assertFalse(PortalApi(fake).getMyBookings().upcoming.single().auntieAssigned)
    }
}
