package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.domain.TestMode
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    /**
     * #575: the two flags PR #571 made reachable. They are OMITTED, not sent
     * false, because the server audits an override it is given and a routine
     * move must not look like an override that was declined.
     */
    @Test
    fun `a routine move carries neither override flag`() {
        val (h, repo) = harness(mapOf("ok" to true, "sessionId" to "sess1"))
        runBlocking { repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00") }
        assertFalse(h.payload.captured.containsKey("overrideVisitConflict"))
        assertFalse(h.payload.captured.containsKey("overrideBusyConflict"))
    }

    @Test
    fun `Move anyway on a visit clash sends overrideVisitConflict and nothing else`() {
        val (h, repo) = harness(mapOf("ok" to true, "sessionId" to "sess1"))
        runBlocking {
            repo.rescheduleBooking(
                "sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00",
                overrideVisitConflict = true,
            )
        }
        assertEquals(true, h.payload.captured["overrideVisitConflict"])
        assertFalse(
            "the two overrides are separate decisions and are audited separately",
            h.payload.captured.containsKey("overrideBusyConflict"),
        )
    }

    @Test
    fun `Move anyway on a busy import sends overrideBusyConflict and nothing else`() {
        val (h, repo) = harness(mapOf("ok" to true, "sessionId" to "sess1"))
        runBlocking {
            repo.rescheduleBooking(
                "sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00",
                overrideBusyConflict = true,
            )
        }
        assertEquals(true, h.payload.captured["overrideBusyConflict"])
        assertFalse(h.payload.captured.containsKey("overrideVisitConflict"))
    }

    /**
     * #575: a refusal now arrives translated at the boundary, so nothing above
     * the repository needs Firebase types to tell an overridable visit clash
     * from a company closure that has no override at all.
     */
    @Test
    fun `a refusal surfaces as BookingRequestRefusedException carrying details code`() {
        val h = Harness()
        val err = mockk<FirebaseFunctionsException>()
        every { err.details } returns mapOf("code" to VISIT_OVERLAP_CONFLICT_CODE)
        every { err.message } returns "That time is already taken: 9:00 AM to 10:00 AM overlaps a visit already booked."
        every { h.ref.call(capture(h.payload)) } throws err
        every { h.functions.getHttpsCallable("rescheduleBooking") } returns h.ref
        val repo = KinCareRepository(
            authGate = passingAuthGate(),
            functionsProvider = { h.functions },
            firestoreProvider = { h.firestore },
        )

        val error = runBlocking {
            repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00")
        }.exceptionOrNull()

        val refusal = error as? BookingRequestRefusedException
        assertEquals(VISIT_OVERLAP_CONFLICT_CODE, refusal?.code)
        assertEquals(
            ScheduleOverrideKind.VISIT,
            overridableScheduleRefusal(refusal?.code, alreadyOverridden = false),
        )
    }

    @Test
    fun `a company closure refusal offers no override`() {
        val h = Harness()
        val err = mockk<FirebaseFunctionsException>()
        every { err.details } returns mapOf("code" to COMPANY_HOLIDAY_CONFLICT_CODE)
        every { err.message } returns "This date is not available. The business is closed."
        every { h.ref.call(capture(h.payload)) } throws err
        every { h.functions.getHttpsCallable("rescheduleBooking") } returns h.ref
        val repo = KinCareRepository(
            authGate = passingAuthGate(),
            functionsProvider = { h.functions },
            firestoreProvider = { h.firestore },
        )

        val error = runBlocking {
            repo.rescheduleBooking("sess1", "2026-08-10T09:00:00", "2026-08-10T10:00:00")
        }.exceptionOrNull()

        assertEquals(
            COMPANY_HOLIDAY_CONFLICT_CODE,
            (error as? BookingRequestRefusedException)?.code,
        )
        assertNull(overridableScheduleRefusal(COMPANY_HOLIDAY_CONFLICT_CODE, alreadyOverridden = false))
    }

    @Test
    fun `a blank session id never reaches the callable`() {
        val (h, repo) = harness(mapOf("ok" to true, "sessionId" to ""))
        val result = runBlocking { repo.rescheduleBooking("", "2026-08-10T09:00:00", "2026-08-10T10:00:00") }
        assertTrue(result.isFailure)
        assertFalse("nothing should have been sent", h.payload.isCaptured)
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
