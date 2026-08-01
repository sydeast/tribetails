package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AO-25: BookingRepository.createMultiDateBookingRequest wraps the
 * createMultiDateBookingRequest callable. Verifies the visits/pattern payload,
 * the result decode, and fail-loud propagation. FirebaseFunctions is mocked.
 *
 * ADR-0003 follow-up: the payload is now built through the generated
 * `CreateMultiDateBookingRequestArgs`, which always sends `serviceId` /
 * `endTimeMs` / `priceCents` / `location` (`null` rather than omitted) --
 * see `BookingRepositoryCreateMultiDateTest` for the drift fix that motivated
 * this (the old hand map had no slot at all for `priceCents`/`location`).
 */
class BookingRepositoryMultiDateTest {

    // firestore is mocked too: BookingRepository's default firestore param calls
    // FirebaseFirestore.getInstance(), which throws with no FirebaseApp under unit test.
    private fun repoWith(functions: FirebaseFunctions) =
        BookingRepository(firestore = mockk<FirebaseFirestore>(relaxed = true), functions = functions)

    @Test
    fun `sends visits + pattern and decodes the result`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        val payload = slot<Map<String, Any>>()
        every { callResult.getData() } returns mapOf(
            "batchId" to "req_1",
            "visitIds" to listOf("v1", "v2"),
            "visitCount" to 2.0, // Firebase serializes JS numbers as Double
        )
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("createMultiDateBookingRequest") } returns ref

        val result = repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(
                NewBookingVisit(startTimeMs = 2_000L, serviceName = "Walk", serviceId = "svc1"),
                NewBookingVisit(startTimeMs = 1_000L, serviceName = "Walk"),
            ),
            pattern = "weekly",
            weeklyDays = listOf(1, 3),
        )

        assertTrue(result.isSuccess)
        val r = result.getOrNull()!!
        assertEquals("req_1", r.batchId)
        assertEquals(2, r.visitCount)
        assertEquals(listOf("v1", "v2"), r.visitIds)

        // Payload shape.
        assertEquals("kf1", payload.captured["kinfolkId"])
        assertEquals("weekly", payload.captured["pattern"])
        // The generated Args' weeklyDays is List<Long> (zod's z.number().int()),
        // so the repository now converts the Int day-of-week list to Long.
        assertEquals(listOf(1L, 3L), payload.captured["weeklyDays"])
        @Suppress("UNCHECKED_CAST")
        val visits = payload.captured["visits"] as List<Map<String, Any?>>
        assertEquals(2, visits.size)
        assertEquals(2_000L, visits[0]["startTimeMs"])
        assertEquals("svc1", visits[0]["serviceId"])
        // ADR-0003 follow-up: the generated Args always sends the key, `null`
        // when the visit has no catalog serviceId, never omitted -- an omitted
        // key is exactly the shape of the drift this follow-up fixed for
        // `priceCents`/`location` on this same visit object.
        assertTrue(visits[1].containsKey("serviceId"))
        assertEquals(null, visits[1]["serviceId"])
    }

    @Test
    fun `rejects an empty visits list without calling the function`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val result = repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = emptyList(),
        )
        assertTrue(result.isFailure)
    }

    @Test
    fun `propagates fail-loud message`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException("not-found: Kinfolk not found"))
        every { functions.getHttpsCallable("createMultiDateBookingRequest") } returns ref

        val result = repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "ghost",
            visits = listOf(NewBookingVisit(startTimeMs = 5_000L, serviceName = "Walk")),
        )
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("not found"))
    }
}
