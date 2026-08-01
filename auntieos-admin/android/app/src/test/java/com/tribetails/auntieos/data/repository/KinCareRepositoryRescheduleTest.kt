package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.domain.TestMode
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ADR-0003 follow-up drift fix: `KinCareRepository.rescheduleBooking` used to
 * discard the callable's response entirely (`Result<Unit>` built from nothing
 * but the fact the call did not throw). Now it decodes the generated
 * `RescheduleBookingResult` and treats `ok: false`, or a `sessionId` that does
 * not match what was requested, as a failure. The mirror-migration itself
 * (`RescheduleBookingArgs.toPayload()` instead of a hand `mapOf`) is proven by
 * the payload assertion below; the behavioural fix is proven by the two
 * failure cases.
 */
class KinCareRepositoryRescheduleTest {

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        coEvery { gate.requireTestMode() } returns TestMode.OFF
        return gate
    }

    private class Harness {
        val firestore = mockk<FirebaseFirestore>()
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val payload = slot<Map<String, Any?>>()
    }

    private fun harness(responseData: Any?): Pair<Harness, KinCareRepository> {
        val h = Harness()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns responseData
        every { h.ref.call(capture(h.payload)) } returns Tasks.forResult(result)
        every { h.functions.getHttpsCallable("rescheduleBooking") } returns h.ref
        val repo = KinCareRepository(
            authGate = passingAuthGate(),
            functionsProvider = { h.functions },
            firestoreProvider = { h.firestore },
        )
        return h to repo
    }

    @Test
    fun `sends the RescheduleBookingArgs wire payload, not a hand-built map`() {
        val (h, repo) = harness(mapOf("ok" to true, "sessionId" to "sess1"))
        runBlocking {
            repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00")
        }
        assertEquals(
            mapOf(
                "sessionId" to "sess1",
                "startTime" to "2026-08-10T09:00:00",
                "endTime" to "2026-08-10T10:00:00",
            ),
            h.payload.captured,
        )
    }

    @Test
    fun `succeeds when the server confirms ok true for the requested session`() {
        val (_, repo) = harness(mapOf("ok" to true, "sessionId" to "sess1"))
        val result = runBlocking { repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00") }
        assertTrue(result.isSuccess)
    }

    @Test
    fun `DRIFT FIX - fails when the response decodes to ok false, instead of a silent success`() {
        val (_, repo) = harness(mapOf("ok" to false, "sessionId" to "sess1"))
        val result = runBlocking { repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00") }
        assertTrue(result.isFailure)
    }

    @Test
    fun `DRIFT FIX - fails when the response echoes a different sessionId than requested`() {
        val (_, repo) = harness(mapOf("ok" to true, "sessionId" to "some-other-session"))
        val result = runBlocking { repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00") }
        assertTrue(result.isFailure)
    }

    @Test
    fun `DRIFT FIX - fails rather than silently succeeding on a non-map response`() {
        val (_, repo) = harness("not-a-map")
        val result = runBlocking { repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00") }
        assertTrue(result.isFailure)
    }
}
