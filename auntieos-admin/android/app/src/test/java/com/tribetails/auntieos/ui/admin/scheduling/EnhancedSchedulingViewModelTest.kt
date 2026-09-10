package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
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
    private lateinit var kinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)

        bookingRepo = mockk()
        serviceRepo = mockk()
        auntieRepo = mockk()
        kinCareRepo = mockk()

        // init { loadInitialData() } fires immediately on construction - stub required.
        coEvery { serviceRepo.getBaseServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        // Stage-0I: the VM's cross-tenant-banner observers resolve sandbox state on init.
        coEvery { auntieRepo.isTestAdminActive() } returns false
        // Unified settings: booking config + timeBlocks now come from BusinessSettings.
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        // Server-stamped calendar-sync receipt; nothing has run in these fixtures.
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        // Live busy-slots stream consumed in init { observeBusyTimeSlots() }.
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        // 16.5: incoming-series stream consumed in init { observeIncomingSeries() }.
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
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns Result.success(emptyList())
        coEvery { kinCareRepo.createKinCareSession(any()) } returns Result.success("session1")
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
        // A SAVED, usable calendar id. The callable resolves the id server-side
        // from this same field, so the VM refuses to call it without one.
        coEvery { auntieRepo.getBusinessSettings() } returns
            Result.success(BusinessSettings(calendarSyncId = "team@group.calendar.google.com"))
        coEvery { auntieRepo.getCalendarSyncRun() } returns
            Result.success(CalendarSyncRun("2026-07-25T14:30:00.000Z", true, 2, ""))
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
        coEvery { auntieRepo.getBusinessSettings() } returns
            Result.success(BusinessSettings(calendarSyncId = "team@group.calendar.google.com"))
        coEvery { auntieRepo.getCalendarSyncRun() } returns
            Result.success(CalendarSyncRun("2026-07-25T14:30:00.000Z", false, 0, serverMsg))
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

    @Test
    fun `importGoogleBusyEvents re-reads the server receipt, including after a failure`() = runTest(testDispatcher) {
        // The stamp, not the transient banner, is what still says "the sync is
        // broken" once this screen is left and reopened.
        coEvery { auntieRepo.getBusinessSettings() } returns
            Result.success(BusinessSettings(calendarSyncId = "team@group.calendar.google.com"))
        coEvery { auntieRepo.getCalendarSyncRun() } returns
            Result.success(CalendarSyncRun("2026-07-25T14:30:00.000Z", false, 0, "calendar_not_shared"))
        coEvery { bookingRepo.syncGoogleBusyEventsViaServer(any()) } returns
            Result.failure(RuntimeException("calendar_not_shared"))

        val vm = buildViewModel()
        vm.importGoogleBusyEvents()
        advanceUntilIdle()

        val run = vm.state.value.calendarSyncRun
        assertNotNull("the server receipt must be re-read after a failed run", run)
        assertFalse("a failed run must not read as a success", run!!.succeeded)
    }

    @Test
    fun `importGoogleBusyEvents refuses a saved id that could only import nothing`() = runTest(testDispatcher) {
        // "team-cal" is not address-shaped. Google answers a typo with notFound
        // and an empty calendar with an empty list, so sending it would come
        // back as "Imported 0 busy blocks", which reads as a clear calendar.
        coEvery { auntieRepo.getBusinessSettings() } returns
            Result.success(BusinessSettings(calendarSyncId = "team-cal"))

        val vm = buildViewModel()
        advanceUntilIdle()
        vm.importGoogleBusyEvents()
        advanceUntilIdle()

        val state = vm.state.value
        assertNotNull("the operator must be told why", state.errorMessage)
        assertTrue(state.errorMessage!!.contains("import nothing"))
        assertNull("no fabricated success line", state.calendarSyncMessage)
        coVerify(exactly = 0) { bookingRepo.syncGoogleBusyEventsViaServer(any()) }
    }

    @Test
    fun `saveCalendarSyncId refuses a mistyped id before it reaches the doc`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.saveCalendarSyncId("primary")
        advanceUntilIdle()

        val state = vm.state.value
        assertTrue(
            "primary is the sync account's own empty calendar and must be refused",
            state.errorMessage!!.contains("always empty")
        )
        assertFalse("nothing was saved", state.calendarSyncIdSaved)
        coVerify(exactly = 0) { auntieRepo.updateBusinessSettingsFields(any(), any()) }
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
        // #536: nothing is dispatched on a partial failure either, so the
        // operator has to know the household is still waiting on an answer.
        assertTrue(err.contains("household has not been told"))
    }
    // #536. Approving a four-day request sent the household one message PER
    // VISIT, and this screen said nothing about it either way. It now sends
    // exactly one, and the screen reports the server's own answer rather than
    // assuming a clean result means a clean message.
    @Test
    fun `approveSeries says the household was told once`() = runTest(testDispatcher) {
        seedIncomingSeries()
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") } returns
            Result.success(
                com.tribetails.auntieos.data.repository.ManageSeriesResult(
                    affectedVisits = 4, newlyConfirmed = 4, householdNotified = true,
                ),
            )
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.approveSeries(vm.state.value.incomingSeries.single())
        advanceUntilIdle()
        val msg = vm.state.value.seriesActionMessage
        assertNotNull(msg)
        assertTrue(msg!!.contains("told once, with every date"))
    }
    @Test
    fun `re-approving a booked request does not claim the household was told again`() =
        runTest(testDispatcher) {
            seedIncomingSeries()
            coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") } returns
                Result.success(
                    com.tribetails.auntieos.data.repository.ManageSeriesResult(
                        affectedVisits = 4, newlyConfirmed = 0, householdNotified = false,
                    ),
                )
            val vm = buildViewModel()
            advanceUntilIdle()
            vm.approveSeries(vm.state.value.incomingSeries.single())
            advanceUntilIdle()
            val msg = vm.state.value.seriesActionMessage
            assertNotNull(msg)
            assertTrue(msg!!.contains("already booked"))
            assertFalse(msg.contains("told once"))
        }
    @Test
    fun `a booking whose confirmation failed tells the operator to reach them another way`() =
        runTest(testDispatcher) {
            // Not an error: the visits ARE on the schedule. But the household
            // does not know, and only this line says so.
            seedIncomingSeries()
            coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") } returns
                Result.success(
                    com.tribetails.auntieos.data.repository.ManageSeriesResult(
                        affectedVisits = 4, newlyConfirmed = 4, householdNotified = false,
                    ),
                )
            val vm = buildViewModel()
            advanceUntilIdle()
            vm.approveSeries(vm.state.value.incomingSeries.single())
            advanceUntilIdle()
            val msg = vm.state.value.seriesActionMessage
            assertNotNull(msg)
            assertTrue(msg!!.contains("did not go out"))
        }
    // CANCEL confirms nothing, so `newlyConfirmed` is always 0 on that path. Its
    // wording must not fall into the re-approve branch and call a decline
    // "already booked".
    @Test
    fun `cancelling a series reports the decline the household heard`() = runTest(testDispatcher) {
        seedIncomingSeries()
        coEvery { auntieRepo.manageBookingSeries("CANCEL", "kf1", "b1") } returns
            Result.success(
                com.tribetails.auntieos.data.repository.ManageSeriesResult(
                    affectedVisits = 4, newlyConfirmed = 0, householdNotified = true,
                ),
            )
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.cancelSeries(vm.state.value.incomingSeries.single())
        advanceUntilIdle()
        val msg = vm.state.value.seriesActionMessage
        assertNotNull(msg)
        // Its OWN line: "with every date" belongs to the confirmation, which
        // enumerates the days. The decline template does not, yet.
        assertTrue(msg!!.contains("The household has your answer."))
        assertFalse(msg.contains("already booked"))
        assertFalse(msg.contains("with every date"))
    }
    // The optimistic state, and the client half of #536's idempotency: the screen
    // marks the batch busy for as long as the callable is in flight, so a second
    // tap cannot fire a second approval, and it clears the flag on every outcome.
    // (The server half is the transactional claim on the envelope, which is what
    // covers two operators on two devices.)
    //
    // The callable is stubbed to SUSPEND, because this dispatcher is unconfined:
    // a stub that returned immediately would have run to completion before
    // `approveSeries` even returned, leaving nothing in flight to test.
    @Test
    fun `a second tap while an approval is in flight does not call the callable twice`() =
        runTest(testDispatcher) {
            seedIncomingSeries()
            coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") } coAnswers {
                kotlinx.coroutines.delay(1_000)
                Result.success(
                    com.tribetails.auntieos.data.repository.ManageSeriesResult(
                        affectedVisits = 4, newlyConfirmed = 4, householdNotified = true,
                    ),
                )
            }
            val vm = buildViewModel()
            advanceUntilIdle()
            val series = vm.state.value.incomingSeries.single()

            vm.approveSeries(series)
            assertEquals("b1", vm.state.value.seriesActionBatchId)
            vm.approveSeries(series)
            advanceUntilIdle()

            assertNull(vm.state.value.seriesActionBatchId)
            coVerify(exactly = 1) { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1") }
        }
}
