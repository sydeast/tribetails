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
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A3: `KinCareRepository`'s OPERATOR status transitions go through the
 * `transitionBookingStatus` callable, and never through Firestore.
 *
 * WHAT THIS FILE IS REALLY FOR. Android held the same hole the React admin did:
 * `markSessionComplete` was a `patchSession` writing
 * `{status: COMPLETED, completedAt}` straight to `kin_care_sessions`, and
 * `EnhancedSchedulingViewModel#bridgeCancellationToSession` wrote
 * `{status: CANCELLED, notes}` the same way. Both are now callable-bound, and
 * `firestore.rules` refuses the direct write. The assertions that matter most
 * here are the NEGATIVE ones: `verify(exactly = 0) { firestore.collection(...) }`.
 * If a future edit puts either transition back on a direct patch, that write
 * would be denied in production and this suite is what says so first.
 *
 * FirebaseFirestore is mocked but deliberately given NO stubs for the session
 * collection, so any direct write attempt fails the test loudly rather than
 * silently succeeding against a relaxed mock.
 */
class KinCareRepositoryTransitionTest {

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
        val payload = slot<Map<String, Any>>()
    }

    private fun harness(failWith: Throwable? = null): Pair<Harness, KinCareRepository> {
        val h = Harness()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns mapOf("ok" to true)
        every { h.ref.call(capture(h.payload)) } returns
            if (failWith == null) Tasks.forResult(result) else Tasks.forException(Exception(failWith))
        every { h.functions.getHttpsCallable("transitionBookingStatus") } returns h.ref
        val repo = KinCareRepository(
            authGate = passingAuthGate(),
            functionsProvider = { h.functions },
            firestoreProvider = { h.firestore },
        )
        return h to repo
    }

    // ── The payload the server's zod contract accepts ────────────────────────

    @Test
    fun `sends sessionId and the action name, and omits the two optional fields when blank`() = runBlocking {
        val (h, repo) = harness()

        val result = repo.transitionBookingStatus("s1", BookingTransitionAction.APPROVE)

        assertTrue(result.isSuccess)
        assertEquals("s1", h.payload.captured["sessionId"])
        assertEquals("APPROVE", h.payload.captured["action"])
        // Both optionals are `min(1)` server-side, so an empty string is an
        // invalid-argument rather than an "unset". They must be ABSENT.
        assertFalse(h.payload.captured.containsKey("completedAt"))
        assertFalse(h.payload.captured.containsKey("reason"))
    }

    @Test
    fun `sends completedAt when one is supplied`() = runBlocking {
        val (h, repo) = harness()
        repo.transitionBookingStatus("s1", BookingTransitionAction.COMPLETE, completedAt = "2026-08-01T10:00:00Z")
        assertEquals("2026-08-01T10:00:00Z", h.payload.captured["completedAt"])
    }

    @Test
    fun `trims the reason and sends it`() = runBlocking {
        val (h, repo) = harness()
        repo.transitionBookingStatus("s1", BookingTransitionAction.CANCEL, reason = "  household away  ")
        assertEquals("household away", h.payload.captured["reason"])
    }

    @Test
    fun `a whitespace-only reason is omitted, not sent as an empty string`() = runBlocking {
        val (h, repo) = harness()
        repo.transitionBookingStatus("s1", BookingTransitionAction.CANCEL, reason = "   ")
        assertFalse(h.payload.captured.containsKey("reason"))
    }

    @Test
    fun `refuses a blank sessionId without calling the function`() = runBlocking {
        val (h, repo) = harness()
        val result = repo.transitionBookingStatus("  ", BookingTransitionAction.CANCEL)
        assertTrue(result.isFailure)
        verify(exactly = 0) { h.functions.getHttpsCallable(any()) }
    }

    // ── markSessionComplete: the old direct patch, now callable-bound ────────

    @Test
    fun `markSessionComplete calls the transition callable with COMPLETE and a completedAt`() = runBlocking {
        val (h, repo) = harness()

        val result = repo.markSessionComplete("s9")

        assertTrue(result.isSuccess)
        assertEquals("s9", h.payload.captured["sessionId"])
        assertEquals("COMPLETE", h.payload.captured["action"])
        assertTrue((h.payload.captured["completedAt"] as String).isNotBlank())
    }

    @Test
    fun `markSessionComplete never writes kin_care_sessions directly`() = runBlocking {
        val (h, repo) = harness()
        repo.markSessionComplete("s9")
        verify(exactly = 0) { h.firestore.collection("kin_care_sessions") }
    }

    @Test
    fun `markSessionComplete propagates a server refusal fail-loud`() = runBlocking {
        val (_, repo) = harness(failWith = RuntimeException("Cannot COMPLETE a booking in status CANCELLED."))
        val result = repo.markSessionComplete("s9")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Cannot COMPLETE"))
    }

    // ── cancelSession: the EnhancedSchedulingViewModel bridge's new path ─────

    @Test
    fun `cancelSession calls the transition callable with CANCEL and the reason`() = runBlocking {
        val (h, repo) = harness()

        val result = repo.cancelSession("s4", "household away")

        assertTrue(result.isSuccess)
        assertEquals("s4", h.payload.captured["sessionId"])
        assertEquals("CANCEL", h.payload.captured["action"])
        assertEquals("household away", h.payload.captured["reason"])
    }

    @Test
    fun `cancelSession never writes kin_care_sessions directly`() = runBlocking {
        val (h, repo) = harness()
        repo.cancelSession("s4", "household away")
        verify(exactly = 0) { h.firestore.collection("kin_care_sessions") }
    }

    @Test
    fun `cancelSession sends CANCEL, never REJECT - they are different decisions`() = runBlocking {
        val (h, repo) = harness()
        repo.cancelSession("s4")
        assertEquals("CANCEL", h.payload.captured["action"])
    }

    @Test
    fun `cancelSession propagates a server refusal fail-loud`() = runBlocking {
        val (_, repo) = harness(failWith = RuntimeException("Cannot CANCEL a booking in status COMPLETED."))
        val result = repo.cancelSession("s4", "household away")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Cannot CANCEL"))
    }

    // ── The in-visit lifecycle deliberately did NOT move ─────────────────────

    @Test
    fun `markSessionDeparted still patches Firestore directly, not the callable`() = runBlocking {
        val (h, repo) = harness()
        val collection = mockk<com.google.firebase.firestore.CollectionReference>()
        val docRef = mockk<com.google.firebase.firestore.DocumentReference>()
        every { h.firestore.collection("kin_care_sessions") } returns collection
        every { collection.document("s7") } returns docRef
        every { docRef.update(any<Map<String, Any>>()) } returns Tasks.forResult(null)

        val result = repo.markSessionDeparted("s7")

        assertTrue(result.isSuccess)
        // The offline write queue is the whole reason this one stays direct.
        verify { h.firestore.collection("kin_care_sessions") }
        verify(exactly = 0) { h.functions.getHttpsCallable("transitionBookingStatus") }
    }
}
