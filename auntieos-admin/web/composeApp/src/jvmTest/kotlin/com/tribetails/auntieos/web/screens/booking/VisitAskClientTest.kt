package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.AskDecision
import com.tribetails.auntieos.web.data.CancelAsk
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.RescheduleAsk
import com.tribetails.auntieos.web.data.ScheduleOverride
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.listCancelAsks
import com.tribetails.auntieos.web.data.listRescheduleAsks
import com.tribetails.auntieos.web.data.resolveRescheduleAsk
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2243: the console answers a household's move or cancellation ask through the
 * callables admin web and Android call, never a path of its own.
 */
class VisitAskClientTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val move = RescheduleAsk(kinfolkId = "kf1", batchId = "b1", visitId = "v1", kinfolkName = "The Wrens")
    private val cancel = CancelAsk(kinfolkId = "kf2", batchId = "b2", visitId = "v2", kinfolkName = "The Fenns")

    private fun last(): Pair<String, JsonObject> {
        val (name, json) = JvmFirestoreFixtures.callablePayloads.last()
        return name to Json.parseToJsonElement(json).jsonObject
    }

    @Test
    fun theQueuesAreReadThroughTheListCallables() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listRescheduleRequests" to """{"requests":[{"kinfolkId":"kf1","batchId":"b1","visitId":"v1","kinfolkName":"The Wrens","kinNames":[]}]}""",
            "listCancelRequests" to """{"requests":[]}""",
        )
        assertEquals(WriteResult.Ok(listOf(move)), listRescheduleAsks())
        assertEquals(WriteResult.Ok(emptyList()), listCancelAsks())
        assertEquals(listOf("listRescheduleRequests", "listCancelRequests"), JvmFirestoreFixtures.callablePayloads.map { it.first })
    }

    @Test
    fun aRefusalKeepsTheServersSentenceAndItsCode() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("resolveBookingRescheduleRequest" to "Auntie has a busy block at that time.")
        JvmFirestoreFixtures.callableErrorCodes = mapOf("resolveBookingRescheduleRequest" to "booking_busy_conflict")
        val r = resolveRescheduleAsk(move, AskDecision.ACCEPT, "")
        assertIs<WriteResult.Err>(r)
        assertEquals("Auntie has a busy block at that time.", r.message)
        assertEquals("booking_busy_conflict", r.code)
    }

    @Test
    fun anAcceptedMoveOverABusyBlockOffersAcceptAnywayOnce() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("resolveBookingRescheduleRequest" to "Auntie has a busy block at that time.")
        JvmFirestoreFixtures.callableErrorCodes = mapOf("resolveBookingRescheduleRequest" to "booking_busy_conflict")
        val row = VisitAsk.Reschedule(move)

        val first = answerVisitAsk(row, AskDecision.ACCEPT, "")
        assertEquals(VisitAskAnswer.Refused("Auntie has a busy block at that time.", ScheduleOverride.BUSY), first)

        // The retry carries the override; the same refusal again is not offered twice.
        val again = answerVisitAsk(row, AskDecision.ACCEPT, "", setOf(ScheduleOverride.BUSY))
        assertEquals(VisitAskAnswer.Refused("Auntie has a busy block at that time.", null), again)
        assertEquals("true", last().second["overrideBusyConflict"]!!.jsonPrimitive.content)

        // A decline is never retried over a conflict.
        assertEquals(VisitAskAnswer.Refused("Auntie has a busy block at that time.", null), answerVisitAsk(row, AskDecision.DECLINE, ""))
    }

    @Test
    fun acceptingACancellationSendsTheAnswerAndReportsWhatTheServerDid() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "resolveBookingCancellationRequest" to """{"ok":true,"visitId":"v2","decision":"accept","status":"cancelled","sessionUpdated":true,"rescheduleRequestClosed":false}""",
        )
        val answer = answerVisitAsk(VisitAsk.Cancel(cancel), AskDecision.ACCEPT, "  Sorry to miss them.  ")
        assertEquals(VisitAskAnswer.Done("Cancelled. It is off the schedule and off the household’s portal."), answer)
        val (name, body) = last()
        assertEquals("resolveBookingCancellationRequest", name)
        assertEquals("kf2", body["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals("b2", body["batchId"]!!.jsonPrimitive.content)
        assertEquals("v2", body["visitId"]!!.jsonPrimitive.content)
        assertEquals("accept", body["decision"]!!.jsonPrimitive.content)
        assertEquals("Sorry to miss them.", body["note"]!!.jsonPrimitive.content)
    }

    @Test
    fun aRefusedCancellationIsTheServersSentenceWithNoRetry() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("resolveBookingCancellationRequest" to "This cancellation request was already answered.")
        val answer = answerVisitAsk(VisitAsk.Cancel(cancel), AskDecision.DECLINE, "")
        assertEquals(VisitAskAnswer.Refused("This cancellation request was already answered.", null), answer)
        assertNull(last().second["note"])
    }

    @Test
    fun oneFailedQueueDoesNotHideTheOther() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listCancelRequests" to """{"requests":[{"kinfolkId":"kf2","batchId":"b2","visitId":"v2","kinfolkName":"The Fenns"}]}""",
        )
        JvmFirestoreFixtures.callableErrors = mapOf("listRescheduleRequests" to "The server could not be reached. Try again in a moment.")
        val state = VisitAskQueueState()
        readVisitAsks(state)
        assertTrue(state.settled)
        assertEquals(listOf("cancel/kf2/b2/v2"), state.rows.map { it.key() })
        assertEquals(listOf("Reschedule requests: The server could not be reached. Try again in a moment."), state.failures)
    }
}
