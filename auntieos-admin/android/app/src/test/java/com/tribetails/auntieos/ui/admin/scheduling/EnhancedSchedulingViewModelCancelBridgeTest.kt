package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * A3: cancelling an enhanced booking cancels its linked `kin_care_sessions`
 * rows THROUGH the `transitionBookingStatus` callable.
 *
 * `bridgeCancellationToSession` used to build a
 * `{status: CANCELLED, notes: ...}` map and hand it to
 * [KinCareRepository.patchKinCareSession], one of the four unaudited status
 * writes A3 closed. `firestore.rules` now refuses that write from any client,
 * so this bridge would fail silently-looking in production if it were ever put
 * back. The `coVerify(exactly = 0) { patchKinCareSession }` below is the guard.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelCancelBridgeTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        bookingRepo = mockk()
        serviceRepo = mockk()
        auntieRepo = mockk()
        kinCareRepo = mockk()

        coEvery { serviceRepo.getBaseServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        coEvery { auntieRepo.isTestAdminActive() } returns false
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { auntieRepo.saveBusinessSettings(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
        coEvery { bookingRepo.updateBooking(any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = EnhancedSchedulingViewModel(
        bookingRepository = bookingRepo,
        serviceRepository = serviceRepo,
        auntieRepository = auntieRepo,
        kinCareRepository = kinCareRepo,
    )

    private fun booking() = EnhancedBooking(
        id = "b1",
        kinfolkId = "kf1",
        startDateTime = "2026-06-02T10:00:00",
        endDateTime = "2026-06-02T11:00:00",
        status = BookingStatus.ACCEPTED,
        notes = "Gate code 1234",
    )

    private fun linkedSession(id: String, status: String = "SCHEDULED") =
        KinCareSession(id = id, kinfolkId = "kf1", status = status)

    @Test
    fun `cancelling a booking cancels each linked session through the callable, with the reason`() =
        runTest(testDispatcher) {
            coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns
                Result.success(listOf(linkedSession("s1"), linkedSession("s2")))
            val ids = mutableListOf<String>()
            val reasons = mutableListOf<String>()
            coEvery { kinCareRepo.cancelSession(capture(ids), capture(reasons)) } returns Result.success(Unit)

            buildViewModel().cancelBooking(booking(), "household away")

            assertEquals(listOf("s1", "s2"), ids)
            assertTrue(reasons.all { it == "household away" })
        }

    @Test
    fun `it never patches the session status directly any more`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns
            Result.success(listOf(linkedSession("s1")))
        coEvery { kinCareRepo.cancelSession(any(), any()) } returns Result.success(Unit)

        buildViewModel().cancelBooking(booking(), "household away")

        coVerify(exactly = 0) { kinCareRepo.patchKinCareSession(any(), any()) }
    }

    @Test
    fun `an already-CANCELLED linked session is skipped, so the callable is never asked to no-op it`() =
        runTest(testDispatcher) {
            coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns
                Result.success(listOf(linkedSession("s1", "CANCELLED"), linkedSession("s2")))
            val ids = mutableListOf<String>()
            coEvery { kinCareRepo.cancelSession(capture(ids), any()) } returns Result.success(Unit)

            buildViewModel().cancelBooking(booking(), "household away")

            assertEquals(listOf("s2"), ids)
        }

    @Test
    fun `no linked sessions means no call at all`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns Result.success(emptyList())

        buildViewModel().cancelBooking(booking(), "household away")

        coVerify(exactly = 0) { kinCareRepo.cancelSession(any(), any()) }
    }

    @Test
    fun `a server refusal on a linked session surfaces, it is not swallowed`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns
            Result.success(listOf(linkedSession("s1")))
        coEvery { kinCareRepo.cancelSession(any(), any()) } returns
            Result.failure(RuntimeException("Cannot CANCEL a booking in status COMPLETED."))

        val vm = buildViewModel()
        vm.cancelBooking(booking(), "household away")

        val message = vm.state.value.errorMessage.orEmpty()
        assertTrue(message, message.contains("Cannot CANCEL a booking in status COMPLETED."))
    }
}
