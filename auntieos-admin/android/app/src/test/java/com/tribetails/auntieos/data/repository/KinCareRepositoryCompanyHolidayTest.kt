package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.KinCareSession
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
 * so [assertNoCompanyHolidayConflict] is the only guard standing between it
 * and a closed day. Mirrors `KinCareRepositoryBusyConflictTest.kt`'s shape
 * for the sibling guard. No override parameter exists for this one, unlike
 * the busy-conflict guard.
 */
class KinCareRepositoryCompanyHolidayTest {

    /** Stubs the busy-slots query to return no rows, so this test isolates the holiday guard. */
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

    private fun session(start: String, end: String) = KinCareSession(
        kinfolkId = "kf1",
        // Non-empty kinIds so the kinForKinfolk auto-fill branch (a separate,
        // unrelated Firestore read) never runs.
        kinIds = listOf("k1"),
        startTime = start,
        endTime = end,
    )

    @Test
    fun `rejects a session on a closed day and writes nothing`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, listOf("2026-12-25|Christmas"))
        val repo = KinCareRepository(authGate = passingAuthGate(), firestoreProvider = { firestore })

        val result = repo.createKinCareSession(session("2026-12-25T15:00:00Z", "2026-12-25T16:00:00Z"))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("Christmas"))
        verify(exactly = 0) { firestore.collection("kin_care_sessions") }
    }

    @Test
    fun `an open day still writes through`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, listOf("2026-12-25|Christmas"))
        mockSessionWrite(firestore)
        val repo = KinCareRepository(authGate = passingAuthGate(), firestoreProvider = { firestore })

        val result = repo.createKinCareSession(session("2026-12-24T15:00:00Z", "2026-12-24T16:00:00Z"))

        assertTrue(result.isSuccess)
    }

    @Test
    fun `no companyHolidays configured at all never blocks`() = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        mockNoBusySlots(firestore)
        mockCompanyHolidays(firestore, null)
        mockSessionWrite(firestore)
        val repo = KinCareRepository(authGate = passingAuthGate(), firestoreProvider = { firestore })

        val result = repo.createKinCareSession(session("2026-12-25T15:00:00Z", "2026-12-25T16:00:00Z"))

        assertTrue(result.isSuccess)
    }
}
