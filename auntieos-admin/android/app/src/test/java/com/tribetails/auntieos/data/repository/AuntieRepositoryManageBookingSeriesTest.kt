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
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0003 follow-up drift fix: `AuntieRepository.manageBookingSeries` used to
 * decode `ok`, `action` and `batchId` off the raw response and never look at
 * any of the three again -- only `affectedVisits`/`failedVisits`/`sessionsCreated`
 * were read. Now `ok: false` fails the call, and an `action`/`batchId` that
 * does not echo the request also fails it, on the theory that the echo is the
 * only thing that ties a response to the request this repository just made.
 *
 * Mirrors AuntieRepositoryBatchUpdateBookingsTest's harness.
 */
class AuntieRepositoryManageBookingSeriesTest {

    private val n8nApi = mockk<N8nApi>()

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        return gate
    }

    private fun repoWith(functions: FirebaseFunctions, authGate: AuthGate = passingAuthGate()): AuntieRepository =
        AuntieRepository(n8n = n8nApi, authGate = authGate, functionsOverride = functions)

    private fun stub(functions: FirebaseFunctions, response: Any?): CapturingRef {
        val ref = mockk<HttpsCallableReference>()
        val payload = slot<Map<String, Any?>>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns response
        every { ref.call(capture(payload)) } returns Tasks.forResult(callResult)
        every { functions.getHttpsCallable("manageBookingSeries") } returns ref
        return CapturingRef(payload)
    }

    private class CapturingRef(val payload: io.mockk.CapturingSlot<Map<String, Any?>>)

    @Test
    fun `sends action kinfolkId batchId as the ManageBookingSeriesArgs wire payload`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val captured = stub(
            functions,
            mapOf("ok" to true, "action" to "APPROVE", "batchId" to "batch1", "affectedVisits" to 2, "sessionsCreated" to 2, "failedVisits" to 0),
        )

        repoWith(functions).manageBookingSeries("APPROVE", "kf1", "batch1")

        assertEquals(
            mapOf("action" to "APPROVE", "kinfolkId" to "kf1", "batchId" to "batch1"),
            captured.payload.captured,
        )
    }

    @Test
    fun `succeeds and decodes counts when ok true and action-batchId echo the request`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(
            functions,
            mapOf("ok" to true, "action" to "APPROVE", "batchId" to "batch1", "affectedVisits" to 3, "sessionsCreated" to 3, "failedVisits" to 0),
        )

        val result = repoWith(functions).manageBookingSeries("APPROVE", "kf1", "batch1")

        assertTrue(result.isSuccess)
        assertEquals(3, result.getOrNull()?.affectedVisits)
        assertEquals(3, result.getOrNull()?.sessionsCreated)
    }

    @Test
    fun `DRIFT FIX - fails when the response decodes to ok false, instead of a silent success`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(
            functions,
            mapOf("ok" to false, "action" to "APPROVE", "batchId" to "batch1", "affectedVisits" to 0, "sessionsCreated" to 0, "failedVisits" to 0),
        )

        val result = repoWith(functions).manageBookingSeries("APPROVE", "kf1", "batch1")

        assertTrue(result.isFailure)
    }

    @Test
    fun `DRIFT FIX - fails when the response echoes a different batchId than requested`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(
            functions,
            mapOf("ok" to true, "action" to "APPROVE", "batchId" to "some-other-batch", "affectedVisits" to 1, "sessionsCreated" to 1, "failedVisits" to 0),
        )

        val result = repoWith(functions).manageBookingSeries("APPROVE", "kf1", "batch1")

        assertTrue(result.isFailure)
    }

    @Test
    fun `DRIFT FIX - fails when the response echoes a different action than requested`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(
            functions,
            mapOf("ok" to true, "action" to "CANCEL", "batchId" to "batch1", "affectedVisits" to 1, "sessionsCreated" to 0, "failedVisits" to 0),
        )

        val result = repoWith(functions).manageBookingSeries("APPROVE", "kf1", "batch1")

        assertTrue(result.isFailure)
    }

    @Test
    fun `DRIFT FIX - fails rather than silently succeeding on a non-map response`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        stub(functions, "not-a-map")

        val result = repoWith(functions).manageBookingSeries("APPROVE", "kf1", "batch1")

        assertTrue(result.isFailure)
    }
}
