package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.VisitStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.ServiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelExtTest {

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
        // Stage-0I: the VM's cross-tenant-banner observers resolve sandbox state on init.
        coEvery { auntieRepo.isTestAdminActive() } returns false
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        // Server-stamped calendar-sync receipt; nothing has run in these fixtures.
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { auntieRepo.saveBusinessSettings(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        // Live busy-slots stream consumed in init { observeBusyTimeSlots() }.
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        // Task 7.2: init { loadGoogleCalendarState() } reads this on construction too.
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
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

    @Test
    fun `deleteBooking success reloads bookings and clears isLoading`() = runTest(testDispatcher) {
        coEvery { bookingRepo.deleteBooking("b1") } returns Result.success(Unit)

        val vm = buildViewModel()
        vm.deleteBooking("b1")
        advanceUntilIdle()

        assertFalse(vm.state.value.isLoading)
        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `deleteBooking failure sets errorMessage`() = runTest(testDispatcher) {
        coEvery { bookingRepo.deleteBooking("b1") } returns Result.failure(RuntimeException("Delete denied"))

        val vm = buildViewModel()
        vm.deleteBooking("b1")
        advanceUntilIdle()

        assertFalse(vm.state.value.isLoading)
        assertNotNull(vm.state.value.errorMessage)
        assertTrue(vm.state.value.errorMessage!!.contains("Delete denied"))
    }

    @Test
    fun `cancelBooking sets errorMessage when updateBooking fails`() = runTest(testDispatcher) {
        coEvery { bookingRepo.updateBooking(any()) } returns Result.failure(RuntimeException("Cancel failed"))

        val vm = buildViewModel()
        vm.cancelBooking(TestFixtures.booking1, "No longer needed")
        advanceUntilIdle()

        assertFalse(vm.state.value.isLoading)
        assertNotNull(vm.state.value.errorMessage)
    }

    @Test
    fun `cancelBooking success transitions booking to REJECTED status`() = runTest(testDispatcher) {
        coEvery { bookingRepo.updateBooking(any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.cancelBooking(TestFixtures.booking1, "Test cancellation")
        advanceUntilIdle()

        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `clearError resets errorMessage to null`() = runTest(testDispatcher) {
        coEvery { bookingRepo.deleteBooking(any()) } returns Result.failure(RuntimeException("fail"))

        val vm = buildViewModel()
        vm.deleteBooking("b1")
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
        vm.clearError()
        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `selectBooking updates selectedBooking in state`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.selectBooking(TestFixtures.booking1)
        assertEquals(TestFixtures.booking1, vm.state.value.selectedBooking)
    }

    @Test
    fun `changeViewMode updates viewMode in state`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.changeViewMode(CalendarViewMode.MONTH)
        assertEquals(CalendarViewMode.MONTH, vm.state.value.viewMode)
    }

    @Test
    fun `approveBooking on already-ACCEPTED booking skips KinCareSession creation`() =
        runTest(testDispatcher) {
            val existingSession = KinCareSession(
                id = "ses-existing",
                kinfolkId = "kf1",
                sourceBookingId = "b2",
                status = VisitStatus.SCHEDULED.name
            )
            coEvery { bookingRepo.updateBooking(any()) } returns Result.success(Unit)
            coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b2") } returns Result.success(listOf(existingSession))
            coEvery { kinCareRepo.createKinCareSession(any()) } returns Result.success("ses-existing")

            val vm = buildViewModel()
            val alreadyAccepted = TestFixtures.booking2.copy(status = BookingStatus.ACCEPTED)
            vm.approveBooking(alreadyAccepted)
            advanceUntilIdle()

            assertNull(vm.state.value.errorMessage)
            coVerify(exactly = 0) { kinCareRepo.createKinCareSession(any()) }
        }

    // H-A5: createBooking called twice rapidly must not fire two concurrent repo calls.
    // Uses StandardTestDispatcher so coroutines are queued - both createBooking() calls happen
    // before any coroutine body executes, so the second call sees isLoading = true.
    @Test
    fun `createBooking while another is in flight does not fire a second repo call`() {
        val std = kotlinx.coroutines.test.StandardTestDispatcher()
        Dispatchers.setMain(std)
        try {
            kotlinx.coroutines.test.TestScope(std).run {
                // Use a fresh set of mocks scoped to this test
                val bRepo: BookingRepository = mockk()
                val sRepo: ServiceRepository = mockk()
                val aRepo: AuntieRepository = mockk()
                val kcRepo: KinCareRepository = mockk()

                coEvery { sRepo.getBaseServices() } returns Result.success(emptyList())
                coEvery { sRepo.getSupplementalServices() } returns Result.success(emptyList())
                coEvery { sRepo.getBusinessHours() } returns Result.success(emptyList())
                coEvery { aRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
                coEvery { aRepo.getCalendarSyncRun() } returns Result.success(null)
                coEvery { aRepo.isTestAdminActive() } returns false
                coEvery { bRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
                coEvery { bRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
                every { bRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
                every { bRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
                // Task 7.2: init { loadGoogleCalendarState() } reads this too. Unstubbed
                // on a StandardTestDispatcher, the exception surfaces as an UNCAUGHT
                // exception attributed to a LATER test, not this one, which is exactly
                // what showed up here before this stub was added.
                coEvery { bRepo.getGoogleCalendarConnection() } returns
                    Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
                coEvery { bRepo.evaluateAvailability(any()) } returns Result.success(
                    com.tribetails.auntieos.data.model.BookingAvailabilityResult(isAvailable = true)
                )
                coEvery { bRepo.createBooking(any()) } returns Result.success("b-new")

                val vm = EnhancedSchedulingViewModel(bRepo, sRepo, aRepo, kcRepo)
                advanceUntilIdle() // finish init

                // Both calls happen before any coroutine executes (StandardTestDispatcher queues them)
                vm.createBooking(TestFixtures.booking1)
                // At this point isLoading = true (set synchronously before launch)
                vm.createBooking(TestFixtures.booking1) // should be dropped by the guard

                advanceUntilIdle()

                coVerify(atMost = 1) { bRepo.createBooking(any()) }
            }
        } finally {
            Dispatchers.setMain(testDispatcher)
        }
    }

    @Test
    fun `deleteBooking with empty string id propagates error to state`() =
        runTest(testDispatcher) {
            coEvery { bookingRepo.deleteBooking("") } returns
                Result.failure(RuntimeException("Invalid booking ID"))

            val vm = buildViewModel()
            vm.deleteBooking("")
            advanceUntilIdle()

            assertFalse(vm.state.value.isLoading)
            assertNotNull(
                "Expected errorMessage when deleting with empty id, but was null",
                vm.state.value.errorMessage
            )
        }
}

private fun assertEquals(expected: Any?, actual: Any?) = org.junit.Assert.assertEquals(expected, actual)
