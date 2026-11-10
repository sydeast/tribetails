package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1799: [FirestoreClient.completeVisitAfterKinTale] on the desktop actuals.
 * A DEPARTED visit the send flagged is completed through
 * `transitionBookingStatus`; nothing else is, and nothing throws. The no-call
 * cases assert the whole callable log is empty, not only the last name.
 */
class CompleteVisitAfterKinTaleClientTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val completed =
        """{"ok":true,"sessionId":"s1","action":"COMPLETE","from":"DEPARTED","status":"COMPLETED","changed":true}"""

    private fun seed(status: String, eligible: Boolean) {
        JvmFirestoreFixtures.sessions = listOf(KinCareSession(_id = "s1", status = status, autoCompleteEligible = eligible))
    }

    @Test
    fun completesADepartedVisitTheSendFlagged() = runBlocking {
        seed("DEPARTED", eligible = true)
        JvmFirestoreFixtures.callableResponses = mapOf("transitionBookingStatus" to completed)
        assertEquals(VisitCompletionAfterSend.Completed, FirestoreClient().completeVisitAfterKinTale("s1"))
        val (name, json) = JvmFirestoreFixtures.callablePayloads.single()
        assertEquals("transitionBookingStatus", name)
        val payload = Json.parseToJsonElement(json).jsonObject
        assertEquals("s1", payload["sessionId"]?.jsonPrimitive?.content)
        assertEquals("COMPLETE", payload["action"]?.jsonPrimitive?.content)
        assertTrue(
            Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}""").containsMatchIn(payload["completedAt"]?.jsonPrimitive?.content.orEmpty()),
            "completedAt must be an ISO stamp",
        )
    }

    @Test
    fun leavesAnArrivedVisitOpen() = runBlocking {
        seed("ARRIVED", eligible = true)
        JvmFirestoreFixtures.callableResponses = mapOf("transitionBookingStatus" to completed)
        assertEquals(VisitCompletionAfterSend.LeftOpen("ARRIVED"), FirestoreClient().completeVisitAfterKinTale("s1"))
        assertTrue(JvmFirestoreFixtures.callablePayloads.isEmpty())
    }

    @Test
    fun leavesAnUnflaggedDepartedVisitOpen() = runBlocking {
        seed("DEPARTED", eligible = false)
        JvmFirestoreFixtures.callableResponses = mapOf("transitionBookingStatus" to completed)
        assertEquals(VisitCompletionAfterSend.LeftOpen("DEPARTED"), FirestoreClient().completeVisitAfterKinTale("s1"))
        assertTrue(JvmFirestoreFixtures.callablePayloads.isEmpty())
    }

    @Test
    fun leavesACompletedVisitAndAMissingOneAlone() = runBlocking {
        seed("COMPLETED", eligible = true)
        JvmFirestoreFixtures.callableResponses = mapOf("transitionBookingStatus" to completed)
        assertEquals(VisitCompletionAfterSend.LeftOpen("COMPLETED"), FirestoreClient().completeVisitAfterKinTale("s1"))
        assertEquals(VisitCompletionAfterSend.LeftOpen(""), FirestoreClient().completeVisitAfterKinTale("s-gone"))
        assertTrue(JvmFirestoreFixtures.callablePayloads.isEmpty())
    }

    @Test
    fun theServerRefusalComesBackWordForWord() = runBlocking {
        seed("DEPARTED", eligible = true)
        val refusal = "This visit has no arrival recorded, and your settings require it before a visit can be marked complete."
        JvmFirestoreFixtures.callableErrors = mapOf("transitionBookingStatus" to refusal)
        assertEquals(VisitCompletionAfterSend.NotCompleted(refusal), FirestoreClient().completeVisitAfterKinTale("s1"))
    }

    @Test
    fun aFailedReadIsNotCompletedAndNeverAsksTheServer() = runBlocking {
        // No session fixture and no token: the fresh read fails at the token check.
        JvmFirestoreFixtures.callableResponses = mapOf("transitionBookingStatus" to completed)
        val r = FirestoreClient().completeVisitAfterKinTale("s1")
        assertTrue(r is VisitCompletionAfterSend.NotCompleted, "got $r")
        assertTrue(r.message.isNotBlank())
        assertTrue(JvmFirestoreFixtures.callablePayloads.isEmpty())
    }

    // ── The REST read itself, against a local stand-in for Firestore ─────────

    @Test
    fun theFreshReadTakesBothFieldsOffTheRawDocument() = runBlocking {
        val fs = MaskApplyingFirestore()
        fs.start()
        try {
            fs.docs["kin_care_sessions/s1"] = buildJsonObject {
                put("status", MaskApplyingFirestore.str("DEPARTED"))
                put("autoCompleteEligible", MaskApplyingFirestore.bool(true))
                // A field the model cannot decode must not hide the two it needs.
                put("serviceDurationMinutes", MaskApplyingFirestore.str("not a number"))
            }
            fs.docs["kin_care_sessions/s2"] = buildJsonObject { put("status", MaskApplyingFirestore.str("DEPARTED")) }
            assertEquals(SessionCompletionFields("DEPARTED", true), platformSessionCompletionFields("s1"))
            assertEquals(SessionCompletionFields("DEPARTED", false), platformSessionCompletionFields("s2"))
            assertNull(platformSessionCompletionFields("s-gone"))
        } finally {
            fs.stop()
        }
    }
}
