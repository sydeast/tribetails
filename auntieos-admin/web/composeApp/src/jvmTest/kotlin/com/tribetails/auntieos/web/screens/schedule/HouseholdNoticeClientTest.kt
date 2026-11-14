package com.tribetails.auntieos.web.screens.schedule

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.HouseholdNotice
import com.tribetails.auntieos.web.screens.HouseholdNoticeKeys
import com.tribetails.auntieos.web.screens.HouseholdNoticePreview
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1838, #2027, #1841, #1816: the console's client reads what each action's
 * callable says the household was told, and asks the preview with the key
 * (and the visit, for a cancel or a move).
 */
class HouseholdNoticeClientTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val told = """{"told":true,"reason":null,"name":"Dre East","channels":["email"]}"""
    private fun lastBody(name: String) =
        Json.parseToJsonElement(JvmFirestoreFixtures.callablePayloads.last { it.first == name }.second).jsonObject

    @Test
    fun aCancelOfASessionReadsTheTransitionsNotice() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to """{"ok":true,"sessionId":"s1","action":"CANCEL","from":"SCHEDULED","status":"CANCELLED","changed":true,"notice":$told}""",
        )
        val r = FirestoreClient().cancelBookingNotice("s1")
        assertEquals(WriteResult.Ok(HouseholdNotice(true, null, "Dre East", listOf("email"))), r)
        assertEquals("CANCEL", lastBody("transitionBookingStatus")["action"]!!.jsonPrimitive.content)
    }

    @Test
    fun aCancelOfAVisitReadsItsEntryInTheBatchNotices() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "batchUpdateBookings" to """{"ok":true,"action":"CANCEL","updated":1,"failed":[],"notices":[{"id":"v1","notice":{"told":false,"reason":"household_notices_off","name":"Dre East","channels":[]}}]}""",
        )
        val r = FirestoreClient().cancelBookingNotice("vis_v1", "v1")
        assertEquals(WriteResult.Ok(HouseholdNotice(false, "household_notices_off", "Dre East", emptyList())), r)
    }

    @Test
    fun anOlderServerWithNoNoticeIsNullNotAClaim() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("transitionBookingStatus" to """{"ok":true,"changed":true}""")
        assertEquals(WriteResult.Ok(null), FirestoreClient().cancelBookingNotice("s1"))
    }

    @Test
    fun aMoveReadsItsNotice() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("rescheduleBooking" to """{"ok":true,"sessionId":"s1","notice":$told}""")
        val out = FirestoreClient().rescheduleOutcome(RescheduleAttempt("s1", "a", "b"))
        assertEquals(RescheduleOutcome.Done(HouseholdNotice(true, null, "Dre East", listOf("email"))), out)
    }

    @Test
    fun theNewVisitSendsTheChoiceAndReadsTheNotice() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createKinCareSession" to """{"ok":true,"sessionId":"vis_1","notice":$told}""")
        val r = FirestoreClient().createKinCareSession("kf1", emptyList(), "30Minute", "2026-12-20T09:00:00Z", "2026-12-20T09:30:00Z", 30, "", notifyHousehold = true)
        assertTrue(r is WriteResult.Ok && r.value.sessionId == "vis_1" && r.value.notice?.told == true)
        assertEquals("true", lastBody("createKinCareSession")["notifyHousehold"]!!.jsonPrimitive.content)
    }

    @Test
    fun aRecordedVisitNeverAsksForAConfirmation() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createKinCareSession" to """{"ok":true,"sessionId":"vis_1"}""")
        FirestoreClient().createKinCareSession("kf1", emptyList(), "30Minute", "2026-05-20T09:00:00Z", "2026-05-20T09:30:00Z", 30, "", recordAsCompleted = true, notifyHousehold = true)
        assertNull(lastBody("createKinCareSession")["notifyHousehold"])
    }

    @Test
    fun thePreviewSendsTheKeyAndTheVisit() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "previewVisitNotification" to """{"ok":true,"willNotify":true,"reason":null,"name":"Dre East","channels":["email"]}""",
        )
        val r = FirestoreClient().previewHouseholdNotice("kf1", HouseholdNoticeKeys.CANCEL, "s1")
        assertEquals(WriteResult.Ok(HouseholdNoticePreview.Ready(true, null, "Dre East", listOf("email"))), r)
        val body = lastBody("previewVisitNotification")
        assertEquals("kincare.booking.cancel", body["key"]!!.jsonPrimitive.content)
        assertEquals("s1", body["sessionId"]!!.jsonPrimitive.content)
    }

    @Test
    fun anOlderServerPreviewIsNoAnswer() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("previewVisitNotification" to """{"ok":true,"willNotify":true,"reason":null}""")
        assertTrue(FirestoreClient().previewHouseholdNotice("kf1", HouseholdNoticeKeys.CHANGED) is WriteResult.Err)
    }

    @Test
    fun aKinTaleSentByWriteWaitsForTheTriggersRecord() = runBlocking {
        val doc = Json.parseToJsonElement("""{"kind":"kintale","notified":false,"reason":"household_notices_off","notice":{"told":false,"reason":"household_notices_off","name":"Dre East","channels":[]}}""").jsonObject
        val asked = mutableListOf<String>()
        val n = FirestoreClient().kinTaleSendNotice("r1", waitMs = 0, read = { asked += it; doc })
        assertEquals(listOf("kintale__r1"), asked)
        assertEquals(HouseholdNotice(false, "household_notices_off", "Dre East", emptyList()), n)
        // No record in time: null, which the toast says as still checking.
        assertNull(FirestoreClient().kinTaleSendNotice("r1", waitMs = 0, read = { null }))
    }
}
