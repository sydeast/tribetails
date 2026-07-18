package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.NewBookingVisitInput
import com.tribetails.auntieos.web.data.WriteResult
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
