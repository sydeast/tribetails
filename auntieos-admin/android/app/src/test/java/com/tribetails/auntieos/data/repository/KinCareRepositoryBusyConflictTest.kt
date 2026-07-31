package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.TimeSlotSource
import com.tribetails.auntieos.domain.TestMode
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [KinCareRepository.createKinCareSession] (the [KinCareSession] overload)
 * writes straight to `kin_care_sessions` with no Cloud Function in between,
 * discovered while mapping every visit-creating write path alongside
 * [BookingRepository.createBooking] (the one the task named explicitly). No
 * override here: neither call site
 * ([AdminDataViewModel.createKinCareSession],
 * [EnhancedSchedulingViewModel]'s booking-approval bridge) shows the operator
 * a conflict before calling this, so a real conflict always refuses.
 *
 * [AuthGate] is mocked directly (mockk handles Kotlin's final classes here,
 * confirmed by [BookingRepositoryMultiDateTest]'s existing FirebaseFunctions
 * mocks) so these tests never touch the real `FirebaseAuth` chain
 * [AuthGate.ensureAuthenticated] / [AuthGate.requireTestMode] would otherwise
 * need.
 */
class KinCareRepositoryBusyConflictTest {

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

    private fun mockSessionWrite(firestore: FirebaseFirestore): DocumentReference {
        val collection = mockk<CollectionReference>()
        val docRef = mockk<DocumentReference>()
        every { firestore.collection("kin_care_sessions") } returns collection
        every { collection.document() } returns docRef
        every { docRef.id } returns "new-session-1"
        every { docRef.set(any()) } returns Tasks.forResult(null)
        return docRef
    }

    private fun passingAuthGate(): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        coEvery { gate.requireTestMode() } returns TestMode.OFF
        return gate
    }

    private fun busySlot(date: String, start: String, end: String) =
        BookingTimeSlot(id = "gbi-1", date = date, startTime = start, endTime = end, source = TimeSlotSource.GOOGLE_BUSY_IMPORT)

    @Test
    fun `rejects a session landing on a GOOGLE_BUSY_IMPORT slot, naming it, and writes nothing`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockBusySlotsQuery(firestore, listOf(busySlot("2026-08-07", "14:00", "15:00")))
        val repo = KinCareRepository(authGate = passingAuthGate(), firestoreProvider = { firestore })

        val session = KinCareSession(
            kinfolkId = "kf1",
            // Non-empty kinIds so the kinForKinfolk auto-fill branch (a
            // separate, unrelated Firestore read) never runs; this test's
            // only concern is the busy-conflict guard.
            kinIds = listOf("k1"),
            startTime = "2026-08-07T14:15:00Z",
            endTime = "2026-08-07T14:45:00Z",
        )
        val result = repo.createKinCareSession(session)

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Google Calendar busy block"))
        verify(exactly = 0) { firestore.collection("kin_care_sessions") }
    }

    @Test
    fun `a non-conflicting session passes unchanged`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockBusySlotsQuery(firestore, listOf(busySlot("2026-09-01", "14:00", "15:00")))
        mockSessionWrite(firestore)
        val repo = KinCareRepository(authGate = passingAuthGate(), firestoreProvider = { firestore })

        val session = KinCareSession(
            kinfolkId = "kf1",
            // Non-empty kinIds so the kinForKinfolk auto-fill branch (a
            // separate, unrelated Firestore read) never runs; this test's
            // only concern is the busy-conflict guard.
            kinIds = listOf("k1"),
            startTime = "2026-08-07T14:15:00Z",
            endTime = "2026-08-07T14:45:00Z",
        )
        val result = repo.createKinCareSession(session)

        assertTrue(result.isSuccess)
    }
}
