package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
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
 * #574: what block-time and unblock actually put on the wire, now that both go
 * through callables instead of a client write `firestore.rules` denies.
 *
 * The SIBLING test (`BookingTimeSlotMergeTest`) proves the direct write is gone.
 * This one proves the replacement is right: the epoch-ms twin is sent (without
 * it the server cannot overlap-check a block at all, so there would be no
 * refusal and no override to offer), the override flag is OMITTED rather than
 * sent false, and a refusal arrives as a [BookingRequestRefusedException]
 * carrying the server's `details.code` so callers branch on a code and never on
 * the wording of a sentence.
 */
class BookingTimeSlotCallableTest {

    private class Harness {
        val firestore = mockk<FirebaseFirestore>()
        val functions = mockk<FirebaseFunctions>()
        val ref = mockk<HttpsCallableReference>()
        val payload = slot<Map<String, Any?>>()
        val name = slot<String>()
    }

    private fun harness(responseData: Any?): Pair<Harness, BookingRepository> {
        val h = Harness()
        val result = mockk<HttpsCallableResult>(relaxed = true)
        every { result.getData() } returns responseData
        every { h.ref.call(capture(h.payload)) } returns Tasks.forResult(result)
        every { h.functions.getHttpsCallable(capture(h.name)) } returns h.ref
        return h to BookingRepository(firestore = h.firestore, functions = h.functions)
    }

    private fun refusingHarness(code: String?, message: String): Pair<Harness, BookingRepository> {
        val h = Harness()
        val err = mockk<FirebaseFunctionsException>()
        every { err.details } returns code?.let { mapOf("code" to it) }
        every { err.message } returns message
        every { h.ref.call(capture(h.payload)) } throws err
        every { h.functions.getHttpsCallable(capture(h.name)) } returns h.ref
        return h to BookingRepository(firestore = h.firestore, functions = h.functions)
    }

    // ── createBlockedTimeSlot ────────────────────────────────────────────────

    @Test
    fun `a block sends the wall clock AND its epoch-ms twin to createBlockedTimeSlot`() {
        val (h, repo) = harness(mapOf("ok" to true, "docId" to "slot-9"))

        val result = runBlocking {
            repo.createBlockedTimeSlot(
                date = "2026-08-24",
                startTime = "09:00",
                endTime = "12:00",
                notes = "Vet appointment",
                startTimeMs = 1_756_000_000_000L,
                endTimeMs = 1_756_010_800_000L,
            )
        }

        assertEquals("createBlockedTimeSlot", h.name.captured)
        assertEquals(
            mapOf(
                "date" to "2026-08-24",
                "startTime" to "09:00",
                "endTime" to "12:00",
                "notes" to "Vet appointment",
                "startTimeMs" to 1_756_000_000_000L,
                "endTimeMs" to 1_756_010_800_000L,
            ),
            h.payload.captured,
        )
        assertEquals("slot-9", result.getOrNull())
    }

    /**
     * The server audits an override it is GIVEN, so a routine block must not
     * look like an override that was declined. Same posture as
     * `createMultiDateBookingRequest`'s optional flags.
     */
    @Test
    fun `a routine block omits overrideVisitConflict rather than sending false`() {
        val (h, repo) = harness(mapOf("ok" to true, "docId" to "slot-9"))

        runBlocking {
            repo.createBlockedTimeSlot("2026-08-24", "09:00", "12:00", "", 1L, 2L)
        }

        assertFalse(
            "a first attempt must not carry the override key at all",
            h.payload.captured.containsKey("overrideVisitConflict"),
        )
    }

    @Test
    fun `Block anyway sends overrideVisitConflict true`() {
        val (h, repo) = harness(mapOf("ok" to true, "docId" to "slot-9"))

        runBlocking {
            repo.createBlockedTimeSlot(
                "2026-08-24", "09:00", "12:00", "", 1L, 2L,
                overrideVisitConflict = true,
            )
        }

        assertEquals(true, h.payload.captured["overrideVisitConflict"])
    }

    @Test
    fun `a visit-overlap refusal surfaces the server code, not its wording`() {
        val (_, repo) = refusingHarness(
            "visit_overlap_conflict",
            "That time is already taken: 3:00 PM to 4:00 PM overlaps a visit already booked.",
        )

        val error = runBlocking {
            repo.createBlockedTimeSlot("2026-08-24", "15:30", "17:00", "", 1L, 2L)
        }.exceptionOrNull()

        val refusal = error as? BookingRequestRefusedException
        assertEquals(VISIT_OVERLAP_CONFLICT_CODE, refusal?.code)
        assertEquals(
            "the operator reads the server's sentence, unchanged",
            "That time is already taken: 3:00 PM to 4:00 PM overlaps a visit already booked.",
            refusal?.message,
        )
    }

    @Test
    fun `a response that does not confirm ok is a failure, not a silent success`() {
        val (_, repo) = harness(mapOf("ok" to false))

        val result = runBlocking {
            repo.createBlockedTimeSlot("2026-08-24", "09:00", "12:00", "", 1L, 2L)
        }

        assertTrue(result.isFailure)
    }

    @Test
    fun `a non-map response is a failure rather than a blank doc id`() {
        val (_, repo) = harness("not-a-map")

        val result = runBlocking {
            repo.createBlockedTimeSlot("2026-08-24", "09:00", "12:00", "", 1L, 2L)
        }

        assertTrue(result.isFailure)
    }

    // ── deleteBlockedTimeSlot ────────────────────────────────────────────────

    @Test
    fun `an unblock calls deleteBlockedTimeSlot with the slot id`() {
        val (h, repo) = harness(mapOf("ok" to true, "slotId" to "slot-1"))

        val result = runBlocking { repo.deleteBlockedTimeSlot("slot-1") }

        assertEquals("deleteBlockedTimeSlot", h.name.captured)
        assertEquals(mapOf("slotId" to "slot-1"), h.payload.captured)
        assertTrue(result.isSuccess)
    }

    @Test
    fun `a blank slot id never reaches the callable`() {
        val (h, repo) = harness(mapOf("ok" to true))

        val result = runBlocking { repo.deleteBlockedTimeSlot("  ".trim()) }

        assertTrue(result.isFailure)
        assertFalse("nothing should have been sent", h.payload.isCaptured)
    }

    /**
     * The Google-mirror refusal. It is NOT a conflict and has no override: the
     * remedy is in Google Calendar, and `overridableScheduleRefusal` returning
     * null for this code is what stops a screen drawing a retry button.
     */
    @Test
    fun `an imported-busy refusal carries its code and offers no override`() {
        val (_, repo) = refusingHarness(
            IMPORTED_BUSY_SLOT_CODE,
            "That busy block is a mirror of an event on the connected Google Calendar",
        )

        val error = runBlocking { repo.deleteBlockedTimeSlot("slot-imported") }.exceptionOrNull()

        assertEquals(IMPORTED_BUSY_SLOT_CODE, (error as? BookingRequestRefusedException)?.code)
        assertNull(overridableScheduleRefusal(IMPORTED_BUSY_SLOT_CODE, alreadyOverridden = false))
    }

    // ── which refusals may be gone past ──────────────────────────────────────

    @Test
    fun `only the two conflict codes are overridable, and never twice`() {
        assertEquals(
            ScheduleOverrideKind.VISIT,
            overridableScheduleRefusal(VISIT_OVERLAP_CONFLICT_CODE, alreadyOverridden = false),
        )
        assertEquals(
            ScheduleOverrideKind.BUSY,
            overridableScheduleRefusal(BOOKING_BUSY_CONFLICT_CODE, alreadyOverridden = false),
        )
        // A company closure is the operator's own statement that the business is
        // shut. `guardCompanyHolidayConflict` has no override parameter at all,
        // so a "Block anyway" beside it would be a button that cannot work.
        assertNull(overridableScheduleRefusal(COMPANY_HOLIDAY_CONFLICT_CODE, alreadyOverridden = false))
        assertNull(overridableScheduleRefusal(null, alreadyOverridden = false))
        // Offering the same losing move twice is what the booking wizard already
        // refuses to do.
        assertNull(overridableScheduleRefusal(VISIT_OVERLAP_CONFLICT_CODE, alreadyOverridden = true))
        assertNull(overridableScheduleRefusal(BOOKING_BUSY_CONFLICT_CODE, alreadyOverridden = true))
    }
}
