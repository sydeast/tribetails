package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull

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
}
