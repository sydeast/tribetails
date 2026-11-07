package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1617: Auntie Time's Mark Completed and Cancel KinCare reach the server
 * through `transitionBookingStatus`, never a status patch the rules refuse.
 * The jvm actual answers callables from [JvmFirestoreFixtures.callableResponses]
 * and records the last name and payload.
 */
class CompleteKinCareClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    @Test
    fun completeSendsCompleteWithCompletedAt() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to
                """{"ok":true,"sessionId":"s1","action":"COMPLETE","from":"ARRIVED","status":"COMPLETED","changed":true}""",
        )
        val r = FirestoreClient().completeKinCare("s1", "2026-11-05T20:30:00Z")
        assertTrue(r is WriteResult.Ok)
        assertEquals("transitionBookingStatus", JvmFirestoreFixtures.lastCallableName)
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("s1", payload["sessionId"]?.jsonPrimitive?.content)
        assertEquals("COMPLETE", payload["action"]?.jsonPrimitive?.content)
        assertEquals("2026-11-05T20:30:00Z", payload["completedAt"]?.jsonPrimitive?.content)
    }

    @Test
    fun cancelSendsCancelWithNoCompletedAt() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to
                """{"ok":true,"sessionId":"s1","action":"CANCEL","from":"SCHEDULED","status":"CANCELLED","changed":true}""",
        )
        val r = FirestoreClient().cancelBooking("s1")
        assertTrue(r is WriteResult.Ok)
        assertEquals("transitionBookingStatus", JvmFirestoreFixtures.lastCallableName)
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("CANCEL", payload["action"]?.jsonPrimitive?.content)
        assertFalse(payload.containsKey("completedAt"))
    }

    @Test
    fun serverRefusalComesBackAsErr() = runBlocking {
        // The server's refusal text is what the toast shows, so it must survive.
        val refusal = "This visit has no arrival and departure recorded."
        JvmFirestoreFixtures.callableErrors = mapOf("transitionBookingStatus" to refusal)
        val r = FirestoreClient().completeKinCare("s1", "2026-11-05T20:30:00Z")
        assertTrue(r is WriteResult.Err)
        assertEquals(refusal, (r as WriteResult.Err).message)
    }
}
