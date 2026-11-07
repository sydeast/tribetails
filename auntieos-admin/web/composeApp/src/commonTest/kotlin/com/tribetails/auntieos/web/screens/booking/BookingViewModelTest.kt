package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.ScheduleOverride
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BookingViewModelTest {

    private fun session(id: String, status: String = "DRAFT") =
        KinCareSession(_id = id, status = status, kinfolkName = "Test Family", serviceType = "Pet Sitting")

    @Test
    fun approveBooking_updates_status_to_SCHEDULED() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b1"))))
        val vm = BookingViewModel(ds)

        vm.approveBooking("b1")

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        val updated = result.value.firstOrNull { it._id == "b1" }
        assertNotNull(updated)
        assertEquals("SCHEDULED", updated.status)
    }

    @Test
    fun rejectBooking_updates_status_to_CANCELLED() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b2"))))
        val vm = BookingViewModel(ds)

        vm.rejectBooking("b2")

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        val updated = result.value.firstOrNull { it._id == "b2" }
        assertNotNull(updated)
        assertEquals("CANCELLED", updated.status)
    }

    @Test
    fun createBooking_adds_booking_to_stream() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(emptyList()))
        val vm = BookingViewModel(ds)

        val newSession = session("b3")
        vm.createBooking(newSession)

        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals(1, result.value.size)
        assertEquals("b3", result.value.first()._id)
    }

    @Test
    fun approveBooking_sets_error_state_on_failure() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b4"))))
        ds.setApproveBookingError("b4", "network failure")
        val vm = BookingViewModel(ds)

        vm.approveBooking("b4")

        assertNotNull(vm.errorMessage)
    }

    // ── #1145: approving a direct session onto a busy block or another visit ──
    @Test
    fun approveRefusedOnABusyBlock_offersApproveAnywayWithTheServersMessage() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b5"))))
        ds.setApproveBookingError("b5", "That time is busy on your calendar.", "booking_busy_conflict")
        val vm = BookingViewModel(ds)
        vm.approveBooking("b5")
        assertEquals("Approve failed: That time is busy on your calendar.", vm.errorMessage)
        assertEquals(ScheduleOverride.BUSY, vm.approveConflict?.override)
        assertEquals("b5", vm.approveConflict?.bookingId)
    }
    @Test
    fun approveAnywayResendsWithTheOverrideThenClearsTheOffer() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b6"))))
        ds.setApproveBookingError("b6", "That time overlaps the Ames visit.", "visit_overlap_conflict")
        val vm = BookingViewModel(ds)
        vm.approveBooking("b6")
        vm.approveAnyway()
        assertEquals(listOf(ScheduleOverride.VISIT), ds.approveOverrides)
        assertNull(vm.approveConflict)
        assertNull(vm.errorMessage)
        val result = ds.sessionsStream().first()
        assertIs<FirestoreResult.Data<List<KinCareSession>>>(result)
        assertEquals("SCHEDULED", result.value.single { it._id == "b6" }.status)
        assertTrue(ds.loggedActivity.any { it.actionType == "APPROVE_BOOKING" })
    }
    // #1702: the server refuses approving a visit whose start has passed (operator
    // ruling for #1574: a past visit only as already Completed). Its sentence
    // reaches the screen, and there is no "Approve anyway" past it.
    @Test
    fun aStartThatHasPassedShowsTheServerSentenceAndOffersNothing() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b8"))))
        val sentence = "The time this request asked for has already passed, so it cannot go on the calendar. " +
            "Decline it, or move the visit to a time still ahead, then approve it."
        ds.setApproveBookingError("b8", sentence, "approve_in_past")
        val vm = BookingViewModel(ds)
        vm.approveBooking("b8")
        assertEquals("Approve failed: $sentence", vm.errorMessage)
        assertNull(vm.approveConflict)
    }
    @Test
    fun aClosedDayShowsTheMessageAndOffersNothing() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b7"))))
        ds.setApproveBookingError("b7", "The office is closed that day.", "company_holiday_conflict")
        val vm = BookingViewModel(ds)
        vm.approveBooking("b7")
        assertEquals("Approve failed: The office is closed that day.", vm.errorMessage)
        assertNull(vm.approveConflict)
    }
    @Test
    fun aRefusalOnAVisitRowOffersNoOverride() = runTest {
        // A row booked from a visit goes through batchUpdateBookings, whose refusals carry no code.
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b8"))))
        ds.setApproveBookingError("b8", "busy", "booking_busy_conflict")
        val vm = BookingViewModel(ds)
        vm.approveBooking("b8", "visit-8")
        assertNull(vm.approveConflict)
    }
    @Test
    fun aNewActionClearsAStaleOffer() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b9"), session("b10"))))
        ds.setApproveBookingError("b9", "busy", "booking_busy_conflict")
        val vm = BookingViewModel(ds)
        vm.approveBooking("b9")
        vm.approveBooking("b10")
        assertNull(vm.approveConflict)
    }
    // ── #1145: cancel is its own audit event ──
    @Test
    fun cancelBooking_isAuditedAsCancelNotAsReject() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b11", "SCHEDULED"))))
        val vm = BookingViewModel(ds)
        vm.cancelBooking("b11")
        assertEquals(listOf("CANCEL_BOOKING"), ds.loggedActivity.map { it.actionType })
    }
    @Test
    fun rejectBooking_stillAuditsAsReject() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitSessions(FirestoreResult.Data(listOf(session("b12"))))
        val vm = BookingViewModel(ds)
        vm.rejectBooking("b12")
        assertEquals(listOf("REJECT_BOOKING"), ds.loggedActivity.map { it.actionType })
    }
}
