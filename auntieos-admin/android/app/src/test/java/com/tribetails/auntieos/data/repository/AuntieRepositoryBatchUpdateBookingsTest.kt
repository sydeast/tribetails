package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * C3: AuntieRepository.batchUpdateBookings is the client half of the
 * batchUpdateBookings callable. The defect this fixes lived entirely
 * server-side (the callable only ever resolved kinCares envelope ids, and
 * android's Bookings/Schedule bulk bar sends `enhanced_bookings` ids), so
 * these tests hold the CLIENT half fixed: they verify the payload this method
 * puts on the wire is exactly `{ids, action}` regardless of which id space the
 * caller (ScheduleViewScreen's bulk bar or NotificationsScreen's quick
 * approve/deny) filled it with, that a real server response decodes end to
 * end, and that the auth gate and error surface behave. Mirrors
 * BookingRepositorySyncTest's pattern: FirebaseFunctions is fully mocked so no
 * network or Android static init is required.
 */
class AuntieRepositoryBatchUpdateBookingsTest {

    private val n8nApi = mockk<N8nApi>()

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        return gate
    }

    private fun repoWith(functions: FirebaseFunctions, authGate: AuthGate = passingAuthGate()): AuntieRepository =
        AuntieRepository(n8n = n8nApi, authGate = authGate, functionsOverride = functions)

    // ── happy path: payload shape, either id space ──────────────────────────

    @Test
    fun `sends ids and action verbatim for android's enhanced_bookings ids (the bulk bar's own id space)`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("ok" to true, "action" to "APPROVE", "updated" to 2, "failed" to emptyList<Any>())
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("batchUpdateBookings") } returns ref

        val result = repoWith(functions).batchUpdateBookings(listOf("eb1", "eb2"), "APPROVE")

        assertTrue(result.isSuccess)
        assertEquals(mapOf("ids" to listOf("eb1", "eb2"), "action" to "APPROVE"), payload.captured)
        assertEquals(2, result.getOrNull()?.updated)
    }

    @Test
    fun `sends ids and action verbatim for a kinCares visit id (Notifications quick approve-deny's id space)`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("ok" to true, "action" to "REJECT", "updated" to 1, "failed" to emptyList<Any>())
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("batchUpdateBookings") } returns ref

        val result = repoWith(functions).batchUpdateBookings(listOf("v1"), "REJECT")

        assertTrue(result.isSuccess)
        assertEquals(mapOf("ids" to listOf("v1"), "action" to "REJECT"), payload.captured)
        assertEquals(1, result.getOrNull()?.updated)
    }

    // ── decode round trip through the real suspend fn ───────────────────────

    @Test
    fun `decodes a mixed batch result end to end (some updated, some failed)`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf(
            "ok" to true,
            "action" to "CANCEL",
            "updated" to 1,
            "failed" to listOf(mapOf("id" to "ghost", "error" to "not-found")),
        )
        every { ref.call(any()) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("batchUpdateBookings") } returns ref

        val result = repoWith(functions).batchUpdateBookings(listOf("eb1", "ghost"), "CANCEL")

        assertTrue(result.isSuccess)
        val decoded = result.getOrNull()!!
        assertEquals(1, decoded.updated)
        assertEquals(1, decoded.failedCount)
        assertEquals("ghost", decoded.failed[0].id)
        assertEquals("not-found", decoded.failed[0].error)
    }

    // ── sad / error paths ────────────────────────────────────────────────────

    @Test
    fun `unauthenticated caller fails loud before ever calling the callable`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } throws IllegalStateException("Admin sign-in required before using AuntieOS.")

        val result = repoWith(functions, authGate = gate).batchUpdateBookings(listOf("eb1"), "APPROVE")

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is IllegalStateException)
    }

    @Test
    fun `a thrown callable, permission-denied say, surfaces as a failed Result, not a crash`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(any()) } returns Tasks.forException(RuntimeException("permission-denied"))
        every { functions.getHttpsCallable("batchUpdateBookings") } returns ref

        val result = repoWith(functions).batchUpdateBookings(listOf("v1"), "APPROVE")

        assertTrue(result.isFailure)
        assertEquals("permission-denied", result.exceptionOrNull()?.message)
    }

    @Test
    fun `an empty id list is still sent (server-side zod is the validator, not this method)`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val payload = slot<Map<String, Any?>>()
        val ref = mockk<HttpsCallableReference>()
        every { ref.call(capture(payload)) } returns Tasks.forException(RuntimeException("invalid-argument"))
        every { functions.getHttpsCallable("batchUpdateBookings") } returns ref

        val result = repoWith(functions).batchUpdateBookings(emptyList(), "APPROVE")

        assertFalse(result.isSuccess)
        assertEquals(mapOf("ids" to emptyList<String>(), "action" to "APPROVE"), payload.captured)
    }
}
