package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.NotificationEntry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1675: Approve / Deny on a "Kinfolk requested a KinCare visit" row. Its
 * targetId is the request's envelope id (`batchId`, from
 * `onBookingEnvelopeCreate`), and the buttons sent it to `batchUpdateBookings`,
 * which only knows visit ids, so every press came back not-found. They answer
 * the whole request through `manageBookingSeries` now, by household and
 * request id, as Bookings' incoming requests do.
 */
class AnswerBookingRequestTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val row = NotificationEntry(
        _id = "n1",
        key = "kincare.requested",
        targetType = "booking",
        targetId = "req_b1",
        data = buildJsonObject { put("kinfolkId", JsonPrimitive("kf1")) },
    )

    private fun lastCall(): Pair<String, kotlinx.serialization.json.JsonObject> {
        val (name, json) = JvmFirestoreFixtures.callablePayloads.last()
        return name to Json.parseToJsonElement(json).jsonObject
    }

    @Test
    fun approveBooksTheWholeRequestByHouseholdAndRequestId() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("manageBookingSeries" to """{"ok":true,"action":"APPROVE","batchId":"req_b1","affectedVisits":2,"failedVisits":0}""")
        val answer = answerBookingRequest(FirestoreClient(), row, approve = true)
        val (name, body) = lastCall()
        assertEquals("manageBookingSeries", name)
        assertEquals("APPROVE", body["action"]!!.jsonPrimitive.content)
        assertEquals("kf1", body["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals("req_b1", body["batchId"]!!.jsonPrimitive.content)
        assertEquals(1, JvmFirestoreFixtures.callablePayloads.size, "no batchUpdateBookings call")
        assertEquals(RequestAnswer(error = null, notice = "Request approved."), answer)
    }

    @Test
    fun denyDeclinesTheWholeRequest() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("manageBookingSeries" to """{"ok":true,"action":"CANCEL","batchId":"req_b1","affectedVisits":2,"failedVisits":0}""")
        val answer = answerBookingRequest(FirestoreClient(), row, approve = false)
        val (name, body) = lastCall()
        assertEquals("manageBookingSeries", name)
        assertEquals("CANCEL", body["action"]!!.jsonPrimitive.content)
        assertEquals("Request declined.", answer.notice)
    }

    @Test
    fun aPartialApprovalIsAFailureNotASuccess() = runBlocking {
        JvmFirestoreFixtures.callableResponses =
            mapOf("manageBookingSeries" to """{"ok":true,"action":"APPROVE","batchId":"req_b1","affectedVisits":2,"failedVisits":1}""")
        val answer = answerBookingRequest(FirestoreClient(), row, approve = true)
        assertNull(answer.notice)
        assertEquals(
            "Approved 2 of 3 visits. The rest did not go through and the household has not been told. " +
                "Open the request in Bookings to finish it.",
            answer.error,
        )
    }

    @Test
    fun aRefusalIsTheServersOwnSentence() = runBlocking {
        val refusal = "Set a start time for the Overnight on Nov 9 before approving."
        JvmFirestoreFixtures.callableErrors = mapOf("manageBookingSeries" to refusal)
        val answer = answerBookingRequest(FirestoreClient(), row, approve = true)
        assertEquals(refusal, answer.error)
        assertNull(answer.notice)
    }
}
