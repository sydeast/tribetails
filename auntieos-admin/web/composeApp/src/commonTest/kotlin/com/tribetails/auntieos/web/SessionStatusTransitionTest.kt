package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.booking.BookingViewModel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionStatusTransitionTest {

    private fun session(id: String, status: String = "DRAFT", serviceType: String = "Pet Sitting") =
        KinCareSession(_id = id, status = status, kinfolkName = "Harris Family", serviceType = serviceType)

    // ── Happy path: DRAFT → SCHEDULED (approve) ───────────────────────────────

    @Test
    fun approve_transitions_DRAFT_to_SCHEDULED() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("s1", "DRAFT"))))
        val vm = BookingViewModel(ds)

        vm.approveBooking("s1")

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals("SCHEDULED", result.value.first { it._id == "s1" }.status)
        assertNull(vm.errorMessage)
    }

    // ── Happy path: DRAFT → CANCELLED (reject) ────────────────────────────────

    @Test
    fun reject_transitions_DRAFT_to_CANCELLED() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("s2", "DRAFT"))))
        val vm = BookingViewModel(ds)

        vm.rejectBooking("s2")

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals("CANCELLED", result.value.first { it._id == "s2" }.status)
        assertNull(vm.errorMessage)
    }

    // ── Happy path: create DRAFT booking ─────────────────────────────────────

    @Test
    fun createBooking_adds_session_with_correct_fields() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        val booking = session("s3", "DRAFT")
        vm.createBooking(booking)

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        val created = result.value.firstOrNull { it._id == "s3" }
        assertNotNull(created)
        assertEquals("DRAFT", created.status)
        assertEquals("Harris Family", created.kinfolkName)
        assertNull(vm.errorMessage)
    }

    // ── Happy path: multiple sessions independent ─────────────────────────────

    @Test
    fun approving_one_does_not_affect_others() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("s4"), session("s5"))))
        val vm = BookingViewModel(ds)

        vm.approveBooking("s4")

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals("SCHEDULED", result.value.first { it._id == "s4" }.status)
        assertEquals("DRAFT",     result.value.first { it._id == "s5" }.status)
    }

    // ── Sad path: serviceType blank blocks create ─────────────────────────────

    @Test
    fun createBooking_blank_serviceType_sets_error() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        vm.createBooking(KinCareSession(_id = "s6", kinfolkName = "Test", serviceType = ""))

        assertNotNull(vm.errorMessage)
        assertTrue(vm.errorMessage!!.contains("serviceType", ignoreCase = true))
        // Session was NOT added
        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertTrue(result.value.isEmpty())
    }

    // ── Error: approve non-existent booking ───────────────────────────────────

    @Test
    fun approve_nonexistent_booking_sets_error() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        vm.approveBooking("ghost-id")

        assertNotNull(vm.errorMessage)
    }

    // ── Error: reject non-existent booking ───────────────────────────────────

    @Test
    fun reject_nonexistent_booking_sets_error() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        vm.rejectBooking("ghost-id")

        assertNotNull(vm.errorMessage)
    }

    // ── Error: data source failure propagates to errorMessage ─────────────────

    @Test
    fun approve_datasource_error_sets_error_message() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("s7"))))
        ds.setApproveBookingError("s7", "Firestore timeout")
        val vm = BookingViewModel(ds)

        vm.approveBooking("s7")

        assertNotNull(vm.errorMessage)
        assertTrue(vm.errorMessage!!.contains("Firestore timeout"))
    }

    @Test
    fun reject_datasource_error_sets_error_message() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("s8"))))
        ds.setRejectBookingError("s8", "offline")
        val vm = BookingViewModel(ds)

        vm.rejectBooking("s8")

        assertNotNull(vm.errorMessage)
        assertTrue(vm.errorMessage!!.contains("offline"))
    }

    // ── Error: clearError resets ──────────────────────────────────────────────

    @Test
    fun clearError_nullifies_error_message() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        vm.approveBooking("not-real")
        assertNotNull(vm.errorMessage)

        vm.clearError()
        assertNull(vm.errorMessage)
    }

    // ── Edge: empty sessions stream still safe ────────────────────────────────

    @Test
    fun approve_when_sessions_loading_returns_error() = runTest {
        val ds = FakeAuntieDataSource()   // Loading state - no emit
        val vm = BookingViewModel(ds)

        vm.approveBooking("s9")

        assertNotNull(vm.errorMessage)
    }
}
