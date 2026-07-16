package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for EnhancedSchedulingViewModel.
 *
 * viewModelScope uses Dispatchers.Main; UnconfinedTestDispatcher replaces it so
 * coroutines launched from init{} and fun bodies run synchronously in tests.
 *
 * Slice 8: importGoogleBusyEvents is now server-backed (no Context); its happy +
 * fail-loud paths are covered below.
 *
 * NOT TESTED HERE: drag-and-drop state mutations (pure synchronous state, no async).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)

        bookingRepo = mockk()
        serviceRepo = mockk()
        auntieRepo = mockk()

        // init { loadInitialData() } fires immediately on construction - stub required.
        coEvery { serviceRepo.getBaseServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        // Unified settings: booking config + timeBlocks now come from BusinessSettings.
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { auntieRepo.saveBusinessSettings(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        // Live busy-slots stream consumed in init { observeBusyTimeSlots() }.
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        // 16.5: incoming-series stream consumed in init { observeIncomingSeries() }.
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = EnhancedSchedulingViewModel(
        bookingRepository = bookingRepo,
        serviceRepository = serviceRepo,
        auntieRepository = auntieRepo
    )

    // ─── approveBooking ───────────────────────────────────────────────────────

    @Test
    fun `approveBooking clears isLoading and errorMessage on success`() = runTest(testDispatcher) {
        val booking = EnhancedBooking(
            id = "b1",
            kinfolkId = "kf1",
            startDateTime = "2026-06-02T10:00:00",
            endDateTime = "2026-06-02T11:00:00",
            status = BookingStatus.DRAFT
        )

        coEvery { bookingRepo.updateBooking(any()) } returns Result.success(Unit)
        coEvery { auntieRepo.getKinCareSessionsBySourceBookingId("b1") } returns Result.success(emptyList())
        coEvery { auntieRepo.createKinCareSession(any()) } returns Result.success("session1")
        // loadBookingsForDateRange re-fires after approve
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.approveBooking(booking)
        advanceUntilIdle()

        val state = vm.state.value
        assertFalse("isLoading must be false after approve completes", state.isLoading)
        assertNull("errorMessage must be null on success", state.errorMessage)
    }

    @Test
    fun `approveBooking sets errorMessage when updateBooking fails`() = runTest(testDispatcher) {
        val booking = EnhancedBooking(
            id = "b2",
            kinfolkId = "kf2",
            startDateTime = "2026-06-02T10:00:00",
            endDateTime = "2026-06-02T11:00:00",
            status = BookingStatus.DRAFT
        )

        coEvery { bookingRepo.updateBooking(any()) } returns Result.failure(RuntimeException("Firestore write failed"))

        val vm = buildViewModel()
        vm.approveBooking(booking)
        advanceUntilIdle()

        val state = vm.state.value
        assertFalse("isLoading must be false after failure", state.isLoading)
        assertNotNull("errorMessage must be set on failure", state.errorMessage)
        assertTrue(
            "Error message should contain upstream cause",
            state.errorMessage!!.contains("Firestore write failed")
        )
    }

    // ─── createBooking - conflict detection ───────────────────────────────────

    @Test
    fun `createBooking shows conflict dialog when availability check returns unavailable`() = runTest(testDispatcher) {
        val booking = EnhancedBooking(
            id = "",
            kinfolkId = "kf3",
            startDateTime = "2026-06-02T10:00:00",
            endDateTime = "2026-06-02T11:00:00",
            status = BookingStatus.DRAFT
        )

        val conflictingBooking = EnhancedBooking(
            id = "conflict1",
            startDateTime = "2026-06-02T10:30:00",
            endDateTime = "2026-06-02T11:30:00"
        )
        val unavailableResult = BookingAvailabilityResult(
            isAvailable = false,
            reason = UnavailabilityReasonType.CONFLICTING_BOOKING,
            conflictingBookings = listOf(conflictingBooking)
        )
        coEvery { bookingRepo.evaluateAvailability(any()) } returns Result.success(unavailableResult)

        // enableConflictDetection = true by default in BusinessSettings
        val vm = buildViewModel()
        vm.createBooking(booking)
        advanceUntilIdle()

        val state = vm.state.value
        assertTrue("showConflictDialog must be true", state.showConflictDialog)
        assertEquals(1, state.conflictingBookings.size)
    }

    // ─── importGoogleBusyEvents (server-side, slice 8) ────────────────────────

    @Test
    fun `importGoogleBusyEvents success sets calendarSyncMessage and clears loading`() = runTest(testDispatcher) {
        coEvery { bookingRepo.syncGoogleBusyEventsViaServer(any()) } returns Result.success(2)
        // loadBookingsForDateRange re-fires after a successful import
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.importGoogleBusyEvents()
        advanceUntilIdle()

        val state = vm.state.value
        assertFalse("isLoading must be false after import completes", state.isLoading)
        assertNull("errorMessage must be null on success", state.errorMessage)
        assertEquals("Imported 2 busy blocks.", state.calendarSyncMessage)
    }

    @Test
    fun `importGoogleBusyEvents failure surfaces the raw server message naming the SA`() = runTest(testDispatcher) {
        val serverMsg =
            "calendar_not_shared: share calendar team-cal with " +
                "auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com at \"See only free/busy (hide details)\" so the sync service account can read availability."
        coEvery { bookingRepo.syncGoogleBusyEventsViaServer(any()) } returns
            Result.failure(RuntimeException(serverMsg))

        val vm = buildViewModel()
        vm.importGoogleBusyEvents()
        advanceUntilIdle()

        val state = vm.state.value
        assertFalse("isLoading must be false after failure", state.isLoading)
        assertNull("no fabricated success line on failure", state.calendarSyncMessage)
        assertNotNull("errorMessage must be set on failure", state.errorMessage)
        assertTrue(
            "error must name the sync service account verbatim",
            state.errorMessage!!.contains("auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com")
        )
    }

    // ─── 16.5 incoming series approve/cancel ──────────────────────────────────

    private fun seedIncomingSeries() {
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(
            Result.success(
                listOf(
                    com.tribetails.auntieos.data.repository.IncomingKinCare(
                        familyId = "kf1", batchId = "b1", visitId = "v1", kinfolkId = "kf1",
                        kinfolkName = "Jane Doe", serviceType = "Walk", startTime = "2026-06-03T09:00:00", status = "requested",
                    ),
                ),
            ),
        )
    }

    @Test
    fun `approveSeries calls manageBookingSeries and reports success`() = runTest(testDispatcher) {
        seedIncomingSeries()
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") } returns
            Result.success(com.tribetails.auntieos.data.repository.ManageSeriesResult(affectedVisits = 1))
        val vm = buildViewModel()
        advanceUntilIdle()
        val series = vm.state.value.incomingSeries.single()
        vm.approveSeries(series)
        advanceUntilIdle()
        coVerify { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") }
        assertNull(vm.state.value.seriesActionBatchId)
        assertTrue(vm.state.value.seriesActionMessage!!.contains("Approved"))
        assertNull(vm.state.value.incomingError)
    }

    @Test
    fun `approveSeries surfaces fail-loud error on failure`() = runTest(testDispatcher) {
        seedIncomingSeries()
        coEvery { auntieRepo.manageBookingSeries(any(), any(), any()) } returns Result.failure(RuntimeException("boom"))
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.approveSeries(vm.state.value.incomingSeries.single())
        advanceUntilIdle()
        assertNull(vm.state.value.seriesActionBatchId)
        assertNotNull(vm.state.value.incomingError)
    }

    // Fail-loud: a partial failure (ok with failedVisits > 0) must surface an
    // error, not a clean "Approved" success message.
    @Test
    fun `approveSeries surfaces fail-loud error on partial failure`() = runTest(testDispatcher) {
        seedIncomingSeries()
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") } returns
            Result.success(com.tribetails.auntieos.data.repository.ManageSeriesResult(affectedVisits = 3, failedVisits = 2))
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.approveSeries(vm.state.value.incomingSeries.single())
        advanceUntilIdle()
        assertNull(vm.state.value.seriesActionBatchId)
        assertNull(vm.state.value.seriesActionMessage)
        val err = vm.state.value.incomingError
        assertNotNull(err)
        assertTrue(err!!.contains("3"))
        assertTrue(err.contains("2"))
    }
}
