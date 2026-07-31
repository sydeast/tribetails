package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.TimeSlotSource
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [BookingRepository.createBooking] writes straight to `enhanced_bookings`
 * with no Cloud Function in between, so this is the ONE place a Google
 * Calendar busy-import conflict can be caught for it. Mirrors the busy-conflict
 * repository-level cases in `mytribe/functions/test/`: a real conflict blocks
 * and writes nothing, `overrideBusyConflict = true` (the "Force Create" path)
 * writes through, and a non-conflicting booking is unaffected.
 */
class BookingRepositoryBusyConflictTest {

    /** Stubs the exact `booking_time_slots` range-query chain [loadGoogleBusySlots] issues. */
    private fun mockBusySlotsQuery(firestore: FirebaseFirestore, rows: List<BookingTimeSlot>) {
        val collection = mockk<CollectionReference>()
        val q1 = mockk<Query>()
        val q2 = mockk<Query>()
        val q3 = mockk<Query>()
        val snapshot = mockk<QuerySnapshot>()
        every { firestore.collection("booking_time_slots") } returns collection
        every { collection.whereGreaterThanOrEqualTo("date", any<String>()) } returns q1
        every { q1.whereLessThanOrEqualTo("date", any<String>()) } returns q2
        every { q2.limit(any()) } returns q3
        every { q3.get() } returns Tasks.forResult(snapshot)
        every { snapshot.toObjects(BookingTimeSlot::class.java) } returns rows
    }

    /** Stubs the `enhanced_bookings` document-create write path so a non-blocked call can succeed. */
    private fun mockBookingWrite(firestore: FirebaseFirestore): DocumentReference {
        val collection = mockk<CollectionReference>()
        val docRef = mockk<DocumentReference>()
        every { firestore.collection("enhanced_bookings") } returns collection
        every { collection.document() } returns docRef
        every { docRef.id } returns "new-booking-1"
        every { docRef.set(any()) } returns Tasks.forResult(null)
        return docRef
    }

    // Real zoned instants (a "Z" suffix), not the bare ISO_LOCAL_DATE_TIME a
    // picker actually writes, so this test is deterministic regardless of the
    // JVM's default timezone: `parseVisitInstant` tries `Instant.parse` first
    // and only falls back to anchoring a bare local string to the system zone
    // (that fallback path has its own fixed-zone coverage in
    // BookingBusyConflictTest). Anchoring THIS test to the runner's default
    // zone would make it pass or fail depending on where it runs.
    private fun booking(start: String, end: String) =
        EnhancedBooking(id = "", kinfolkId = "kf1", startDateTime = start, endDateTime = end)

    private fun busySlot(date: String, start: String, end: String) =
        BookingTimeSlot(id = "gbi-1", date = date, startTime = start, endTime = end, source = TimeSlotSource.GOOGLE_BUSY_IMPORT)

    @Test
    fun `rejects a booking landing on a GOOGLE_BUSY_IMPORT slot, naming it, and writes nothing`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockBusySlotsQuery(firestore, listOf(busySlot("2026-08-07", "14:00", "15:00")))
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(booking("2026-08-07T14:15:00Z", "2026-08-07T14:45:00Z"))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Google Calendar busy block"))
        io.mockk.verify(exactly = 0) { firestore.collection("enhanced_bookings") }
    }

    @Test
    fun `overrideBusyConflict true writes the booking through (the existing Force Create affordance)`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockBusySlotsQuery(firestore, listOf(busySlot("2026-08-07", "14:00", "15:00")))
        val docRef = mockBookingWrite(firestore)
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(
            booking("2026-08-07T14:15:00Z", "2026-08-07T14:45:00Z"),
            overrideBusyConflict = true,
        )

        assertTrue(result.isSuccess)
        assertFalse(result.getOrNull().isNullOrBlank())
        io.mockk.verify(exactly = 1) { docRef.set(any()) }
    }

    @Test
    fun `a non-conflicting booking passes unchanged`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        // Busy slot on a completely different day.
        mockBusySlotsQuery(firestore, listOf(busySlot("2026-09-01", "14:00", "15:00")))
        val docRef = mockBookingWrite(firestore)
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(booking("2026-08-07T14:15:00Z", "2026-08-07T14:45:00Z"))

        assertTrue(result.isSuccess)
        io.mockk.verify(exactly = 1) { docRef.set(any()) }
    }
}
