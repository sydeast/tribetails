package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsBilling
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsCommunication
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0003 follow-up drift fix: `BookingRepository.createMultiDateBookingRequest`
 * used to build its own payload map by hand, and that map had NO slot at all
 * for `priceCents`, `location`, `billing`, `communication` or
 * `overrideBusyConflict` -- not "the UI doesn't collect them", but "there was
 * nowhere on the wire for them to go even if it did." Now the payload is
 * built through the generated `CreateMultiDateBookingRequestArgs`, which has
 * a slot for all five. These tests prove the wire payload actually carries
 * them.
 */
class BookingRepositoryCreateMultiDateTest {

    private fun repoWith(functions: FirebaseFunctions): BookingRepository =
        BookingRepository(firestore = mockk<FirebaseFirestore>(), functions = functions)

    private fun stub(functions: FirebaseFunctions, response: Any?): io.mockk.CapturingSlot<Map<String, Any?>> {
        val ref = mockk<HttpsCallableReference>()
        val payload = slot<Map<String, Any?>>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns response
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("createMultiDateBookingRequest") } returns ref
        return payload
    }

    @Test
    fun `DRIFT FIX - the wire payload now carries priceCents and location on every visit, as an honest null`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions, mapOf("batchId" to "batch1", "visitIds" to listOf("v1"), "visitCount" to 1))

        repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(NewBookingVisit(startTimeMs = 1000L, serviceName = "Dog Walking")),
        )

        @Suppress("UNCHECKED_CAST")
        val visits = payload.captured["visits"] as List<Map<String, Any?>>
        assertEquals(1, visits.size)
        assertTrue("priceCents key must be present", visits[0].containsKey("priceCents"))
        assertTrue("location key must be present", visits[0].containsKey("location"))
        assertEquals(null, visits[0]["priceCents"])
        assertEquals(null, visits[0]["location"])
    }

    @Test
    fun `DRIFT FIX - billing and communication reach the wire when the caller supplies them`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions, mapOf("batchId" to "batch1", "visitIds" to listOf("v1"), "visitCount" to 1))

        repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(NewBookingVisit(startTimeMs = 1000L, serviceName = "Dog Walking")),
            billing = CreateMultiDateBookingRequestArgsBilling(mode = "new-invoice"),
            communication = CreateMultiDateBookingRequestArgsCommunication(emailConfirmation = true, timeVisibility = false),
        )

        assertEquals(mapOf("mode" to "new-invoice"), payload.captured["billing"])
        assertEquals(
            mapOf("emailConfirmation" to true, "timeVisibility" to false),
            payload.captured["communication"],
        )
    }

    @Test
    fun `DRIFT FIX - overrideBusyConflict reaches the wire, not silently dropped`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions, mapOf("batchId" to "batch1", "visitIds" to listOf("v1"), "visitCount" to 1))

        repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(NewBookingVisit(startTimeMs = 1000L, serviceName = "Dog Walking")),
            overrideBusyConflict = true,
        )

        assertEquals(true, payload.captured["overrideBusyConflict"])
    }

    @Test
    fun `overrideBusyConflict defaults false and still reaches the wire (never silently omitted)`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = stub(functions, mapOf("batchId" to "batch1", "visitIds" to listOf("v1"), "visitCount" to 1))

        repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1",
            visits = listOf(NewBookingVisit(startTimeMs = 1000L, serviceName = "Dog Walking")),
        )

        assertEquals(false, payload.captured["overrideBusyConflict"])
    }
}
