package com.tribetails.auntieos.web.screens.booking
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.ScheduleOverride
import com.tribetails.auntieos.web.data.overridableScheduleRefusal
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
/**
 * #1129: the desktop single-row Approve / Reject / Cancel used to PATCH
 * `kin_care_sessions.status` directly, so the server's busy and closed-day
 * checks, the household's answer and the Overnight start-time refusal never ran.
 * They now go through `batchUpdateBookings` (a row booked from a visit) or
 * `transitionBookingStatus` (a direct session), and a per-id refusal reaches the
 * operator in the server's own words.
 */
class SingleRowBookingServerTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()
    private fun lastCall(): Triple<String, String, kotlinx.serialization.json.JsonObject> {
        val (name, json) = JvmFirestoreFixtures.callablePayloads.last()
        return Triple(name, json, Json.parseToJsonElement(json).jsonObject)
    }
    @Test
    fun approveOfAVisitRowSendsTheVisitIdToBatchUpdateBookings() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("batchUpdateBookings" to """{"ok":true,"action":"APPROVE","updated":1,"failed":[]}""")
        val row = KinCareSession(_id = "vis_v1", kinCareVisitId = "v1")
        val r = FirestoreClient().approveBooking(row._id, singleVisitId(row))
        assertTrue(r is WriteResult.Ok)
        val (name, _, body) = lastCall()
        assertEquals("batchUpdateBookings", name)
        assertEquals("APPROVE", body["action"]!!.jsonPrimitive.content)
        assertEquals(listOf("v1"), body["ids"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(1, JvmFirestoreFixtures.callablePayloads.size)
        assertEquals(null, JvmFirestoreFixtures.lastWrite, "no direct status PATCH")
    }
    @Test
    fun rejectAndCancelUseTheirOwnServerActions() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("batchUpdateBookings" to """{"ok":true,"action":"X","updated":1,"failed":[]}""")
        FirestoreClient().rejectBooking("vis_v1", "v1")
        assertEquals("REJECT", lastCall().third["action"]!!.jsonPrimitive.content)
        FirestoreClient().cancelBooking("vis_v1", "v1")
        assertEquals("CANCEL", lastCall().third["action"]!!.jsonPrimitive.content)
    }
    @Test
    fun aRefusedApprovalSurfacesTheServersWords() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "batchUpdateBookings" to
                """{"ok":true,"action":"APPROVE","updated":0,"failed":[{"id":"v1","error":"Set the start time before approving this Overnight."}]}""",
        )
        val r = FirestoreClient().approveBooking("vis_v1", "v1")
        assertTrue(r is WriteResult.Err)
        assertEquals("Set the start time before approving this Overnight.", (r as WriteResult.Err).message)
    }
    @Test
    fun aRefusalNeverReadsAsApproved() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("batchUpdateBookings" to """{"ok":true,"action":"APPROVE","updated":0,"failed":[]}""")
        val r = FirestoreClient().approveBooking("vis_v1", "v1")
        assertTrue(r is WriteResult.Err)
    }
    @Test
    fun aDirectSessionTakesTheSessionCallableNotAStatusPatch() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to
                """{"ok":true,"sessionId":"s9","action":"APPROVE","from":"DRAFT","status":"SCHEDULED","changed":true}""",
        )
        val row = KinCareSession(_id = "s9")
        assertEquals(null, singleVisitId(row))
        val r = FirestoreClient().approveBooking(row._id, singleVisitId(row))
        assertTrue(r is WriteResult.Ok)
        val (name, _, body) = lastCall()
        assertEquals("transitionBookingStatus", name)
        assertEquals("s9", body["sessionId"]!!.jsonPrimitive.content)
        assertEquals("APPROVE", body["action"]!!.jsonPrimitive.content)
        assertEquals(null, JvmFirestoreFixtures.lastWrite, "no direct status PATCH")
    }
    @Test
    fun aDirectSessionRefusalComesBackAsAnError() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("transitionBookingStatus" to "Cannot approve a cancelled booking.")
        val r = FirestoreClient().approveBooking("s9", null)
        assertEquals("Cannot approve a cancelled booking.", (r as WriteResult.Err).message)
    }
    @Test
    fun aDirectApprovalRefusedOnABusyBlockOrAVisitCarriesTheServersCode() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("transitionBookingStatus" to "That time is busy on your calendar.")
        JvmFirestoreFixtures.callableErrorCodes = mapOf("transitionBookingStatus" to "booking_busy_conflict")
        val r = FirestoreClient().approveBooking("s9", null)
        assertEquals(WriteResult.Err("That time is busy on your calendar.", "booking_busy_conflict"), r)
        assertEquals(ScheduleOverride.BUSY, overridableScheduleRefusal((r as WriteResult.Err).code))
        assertEquals(ScheduleOverride.VISIT, overridableScheduleRefusal("visit_overlap_conflict"))
        assertEquals(null, overridableScheduleRefusal("company_holiday_conflict"), "a closed day is never overridable")
        assertEquals(null, overridableScheduleRefusal(null))
    }
    @Test
    fun approveAnywaySendsTheMatchingOverrideFlagAndOnlyThat() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to
                """{"ok":true,"sessionId":"s9","action":"APPROVE","from":"DRAFT","status":"SCHEDULED","changed":true}""",
        )
        val busy = FirestoreClient().approveBooking("s9", null, ScheduleOverride.BUSY)
        assertTrue(busy is WriteResult.Ok)
        val busyBody = lastCall().third
        assertEquals("true", busyBody["overrideBusyConflict"]!!.jsonPrimitive.content)
        assertEquals(null, busyBody["overrideVisitConflict"])
        FirestoreClient().approveBooking("s9", null, ScheduleOverride.VISIT)
        val visitBody = lastCall().third
        assertEquals("true", visitBody["overrideVisitConflict"]!!.jsonPrimitive.content)
        assertEquals(null, visitBody["overrideBusyConflict"])
    }
    @Test
    fun aFirstApprovalSendsNoOverrideFlag() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to
                """{"ok":true,"sessionId":"s9","action":"APPROVE","from":"DRAFT","status":"SCHEDULED","changed":true}""",
        )
        FirestoreClient().approveBooking("s9", null)
        val body = lastCall().third
        assertEquals(null, body["overrideBusyConflict"])
        assertEquals(null, body["overrideVisitConflict"])
    }
    @Test
    fun singleVisitIdPrefersTheVisitThenTheSourceBookingAndIsNullForADirectRow() {
        assertEquals("v1", singleVisitId(KinCareSession(_id = "vis_v1", kinCareVisitId = "v1", sourceBookingId = "src")))
        assertEquals("src", singleVisitId(KinCareSession(_id = "x", sourceBookingId = "src")))
        assertEquals(null, singleVisitId(KinCareSession(_id = "x")))
    }
}
