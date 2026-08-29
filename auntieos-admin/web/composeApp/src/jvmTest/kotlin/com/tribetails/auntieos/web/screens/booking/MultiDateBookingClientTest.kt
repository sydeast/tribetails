package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.NewBookingVisitInput
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.mintBookingIdempotencyKey
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * AO-25: FirestoreClient.createMultiDateBookingRequest routes through
 * platformInvokeCallable, answered on jvm by JvmFirestoreFixtures. The jvm actual
 * is shared with desktop, so this proves the desktop path decodes the result and
 * sends the visits/pattern payload the callable expects.
 */
class MultiDateBookingClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    @Test
    fun sendsVisitsAndPatternAndDecodesResult() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "createMultiDateBookingRequest" to """{"batchId":"req_1","visitIds":["v1","v2"],"visitCount":2}""",
        )
        val r = FirestoreClient().createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(
                NewBookingVisitInput(startTimeMs = 2_000L, serviceName = "Walk", serviceId = "svc1"),
                NewBookingVisitInput(startTimeMs = 1_000L, serviceName = "Walk"),
            ),
            pattern = "weekly",
            weeklyDays = listOf(1, 3),
        )
        assertTrue(r is WriteResult.Ok)
        val v = (r as WriteResult.Ok).value
        assertEquals("req_1", v.batchId)
        assertEquals(2, v.visitCount)
        assertEquals(listOf("v1", "v2"), v.visitIds)

        assertEquals("createMultiDateBookingRequest", JvmFirestoreFixtures.lastCallableName)
        val payload = JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
        assertTrue(payload.contains("\"weekly\""))
        assertTrue(payload.contains("startTimeMs"))
        assertTrue(payload.contains("svc1"))
    }

    /**
     * #644: the console sends the caller's booking id when it has one.
     *
     * This surface does NOT retry automatically -- its transport reports a
     * failure as a message string with no code, so it cannot tell a dropped
     * request from a refusal and a retry it cannot classify would be a guess.
     * The key still earns its place here: it is what makes an OPERATOR pressing
     * Create again land on the booking the first press may already have made,
     * rather than on a second one.
     */
    @Test
    fun sendsTheIdempotencyKeyWhenTheCallerSuppliesOne() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "createMultiDateBookingRequest" to """{"batchId":"req_1756400000000_a1b2c3","visitIds":["v1"],"visitCount":1}""",
        )
        FirestoreClient().createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(NewBookingVisitInput(startTimeMs = 2_000L, serviceName = "Walk")),
            idempotencyKey = "req_1756400000000_a1b2c3",
        )
        val payload = JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
        assertTrue(payload.contains("\"idempotencyKey\":\"req_1756400000000_a1b2c3\""))
    }

    @Test
    fun omitsTheKeyEntirelyWhenTheCallerHasNone() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "createMultiDateBookingRequest" to """{"batchId":"req_1","visitIds":["v1"],"visitCount":1}""",
        )
        FirestoreClient().createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(NewBookingVisitInput(startTimeMs = 2_000L, serviceName = "Walk")),
        )
        // Absent, not null: the callable's zod guard would refuse an explicit
        // null, and an unkeyed request is meant to behave exactly as it did
        // before #644 -- server-minted id, no dedupe.
        assertTrue(!JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains("idempotencyKey"))
    }

    /** A bare uuid is refused by the callable's zod guard, so the shape matters. */
    @Test
    fun mintsTheIdShapeTheServerMints() {
        assertTrue(Regex("^req_[0-9]{10,16}_[a-z0-9]{1,16}$").matches(mintBookingIdempotencyKey()))
    }

    @Test
    fun malformedResponseSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createMultiDateBookingRequest" to "not-json{")
        val r = FirestoreClient().createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(NewBookingVisitInput(startTimeMs = 5_000L, serviceName = "Walk")),
        )
        assertTrue(r is WriteResult.Err)
    }
}
