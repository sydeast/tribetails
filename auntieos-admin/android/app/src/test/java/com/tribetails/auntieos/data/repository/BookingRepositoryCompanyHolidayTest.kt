package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.EnhancedBooking
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [BookingRepository.createBooking] writes straight to `enhanced_bookings`
 * with no Cloud Function in between, so [assertNoCompanyHolidayConflict] is
 * the only guard standing between it and a closed day. Mirrors
 * `BookingRepositoryBusyConflictTest.kt`'s shape for the sibling guard.
 * UNLIKE the busy-conflict guard, there is no override here at all -- a
 * closed day always refuses, whether or not `overrideBusyConflict` is set.
 */
class BookingRepositoryCompanyHolidayTest {

    /** Stubs the busy-slots query to return no rows, so the busy-conflict guard always passes and this test isolates the holiday guard. */
    private fun mockNoBusySlots(firestore: FirebaseFirestore) {
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
        every { snapshot.toObjects(BookingTimeSlot::class.java) } returns emptyList()
    }

    private fun mockCompanyHolidays(firestore: FirebaseFirestore, entries: List<String>?) {
        val docRef = mockk<DocumentReference>()
        val snapshot = mockk<DocumentSnapshot>()
        every { firestore.document("business_settings/business_settings") } returns docRef
        every { docRef.get() } returns Tasks.forResult(snapshot)
        every { snapshot.get("companyHolidays") } returns entries
    }

    private fun mockBookingWrite(firestore: FirebaseFirestore): DocumentReference {
        val collection = mockk<CollectionReference>()
        val docRef = mockk<DocumentReference>()
        every { firestore.collection("enhanced_bookings") } returns collection
        every { collection.document() } returns docRef
        every { docRef.id } returns "new-booking-1"
        every { docRef.set(any()) } returns Tasks.forResult(null)
        return docRef
    }

    private fun booking(start: String, end: String) =
        EnhancedBooking(id = "", kinfolkId = "kf1", startDateTime = start, endDateTime = end)

    @Test
    fun `rejects a booking on a closed day and writes nothing`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, listOf("2026-12-25|Christmas"))
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(booking("2026-12-25T15:00:00Z", "2026-12-25T16:00:00Z"))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Christmas"))
        verify(exactly = 0) { firestore.collection("enhanced_bookings") }
    }

    @Test
    fun `overrideBusyConflict true does NOT bypass the holiday guard`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, listOf("2026-12-25|Christmas"))
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(
            booking("2026-12-25T15:00:00Z", "2026-12-25T16:00:00Z"),
            overrideBusyConflict = true,
        )

        assertTrue(result.isFailure)
        verify(exactly = 0) { firestore.collection("enhanced_bookings") }
    }

    @Test
    fun `a recurring yearly closure blocks a future year the entry never names`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, listOf("yearly:07-04|Independence Day"))
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(booking("2031-07-04T15:00:00Z", "2031-07-04T16:00:00Z"))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Independence Day"))
    }

    @Test
    fun `an open day still writes through`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, listOf("2026-12-25|Christmas"))
        val docRef = mockBookingWrite(firestore)
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(booking("2026-12-24T15:00:00Z", "2026-12-24T16:00:00Z"))

        assertTrue(result.isSuccess)
        assertFalse(result.getOrNull().isNullOrBlank())
        verify(exactly = 1) { docRef.set(any()) }
    }

    @Test
    fun `no companyHolidays configured at all never blocks`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, null)
        val docRef = mockBookingWrite(firestore)
        val repo = BookingRepository(firestore = firestore, functions = mockk<FirebaseFunctions>(relaxed = true))

        val result = repo.createBooking(booking("2026-12-25T15:00:00Z", "2026-12-25T16:00:00Z"))

        assertTrue(result.isSuccess)
        verify(exactly = 1) { docRef.set(any()) }
    }
}
