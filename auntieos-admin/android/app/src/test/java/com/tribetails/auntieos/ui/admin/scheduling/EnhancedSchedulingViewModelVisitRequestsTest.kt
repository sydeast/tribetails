package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.CancelRequestDto
import com.tribetails.auntieos.data.contracts.RescheduleRequestDto
import com.tribetails.auntieos.data.contracts.ResolveBookingCancellationRequestResult
import com.tribetails.auntieos.data.contracts.ResolveBookingRescheduleRequestResult
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BOOKING_BUSY_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.BookingRequestRefusedException
import com.tribetails.auntieos.data.repository.IncomingKinCare
import com.tribetails.auntieos.data.repository.ManageSeriesResult
import com.tribetails.auntieos.data.repository.ScheduleOverrideKind
import com.tribetails.auntieos.data.repository.VISIT_OVERLAP_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.data.repository.VisitRequestRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import java.time.Instant
import java.time.LocalTime
import org.junit.Test

/**
 * #438: the admin Android end of the household's change requests.
 *
 * The cancellation ask is the one that had never been read at ALL. It has been
 * written to the visit since 2026-07-02 and no admin surface, web or Android,
 * ever looked at it, so the household was told their request was sent and the
 * office never saw it. What is asserted here is that the queue loads, that a
 * broken read of one queue cannot hide the other, that a decline with no note
 * still reaches the server (#700: the office does not owe a reason), and that
 * a REFUSED decision leaves the row on screen rather than quietly dropping it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelVisitRequestsTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private lateinit var visitRequestRepo: VisitRequestRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        bookingRepo = mockk()
        serviceRepo = mockk()
        auntieRepo = mockk()
        kinCareRepo = mockk()
        visitRequestRepo = mockk()

        coEvery { serviceRepo.getBaseServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        coEvery { auntieRepo.isTestAdminActive() } returns false
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))

        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(emptyList())
        coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(emptyList())
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
        visitRequestRepository = visitRequestRepo,
    )

    private fun cancelDto(visitId: String = "v1", requestedAtMs: Long? = 100L) = CancelRequestDto(
        kinfolkId = "fam-1",
        batchId = "b1",
        visitId = visitId,
        title = "Evening sit",
        serviceType = "Pet Sitting",
        kinNames = listOf("Nutmeg"),
        status = "confirmed",
        startTimeMs = 1_700_000_000_000L,
        endTimeMs = null,
        reason = "We are away",
        requestedAtMs = requestedAtMs,
    )

    private fun rescheduleDto(visitId: String = "v2", requestedAtMs: Long? = 200L) = RescheduleRequestDto(
        kinfolkId = "fam-2",
        batchId = "b2",
        visitId = visitId,
        title = "Morning drop-in",
        serviceType = "Drop-in Visit",
        kinNames = listOf("Biscuit"),
        status = "confirmed",
        currentStartTimeMs = 1_700_000_000_000L,
        currentEndTimeMs = null,
        proposedStartTimeMs = 1_700_100_000_000L,
        proposedEndTimeMs = null,
        reason = "Flight moved",
        requestedAtMs = requestedAtMs,
    )

    @Test
    fun `both queues load into one list, oldest first`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto()))
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns
            Result.success(listOf(rescheduleDto()))

        val state = buildViewModel().state.value
        assertEquals(listOf("Cancel", "Reschedule"), state.visitRequests.map { it.kindLabel() })
        assertNull(state.visitRequestsError)
    }

    @Test
    fun `visitRequestsLoading reserves the panel until both queues settle (#698)`() = runTest(testDispatcher) {
        // `loadVisitRequests` runs as its own fire-and-forget call in `init`,
        // separate from `isLoading` (which only covers `loadInitialData`), so a
        // cold-start read used to pop the panel in seconds after the rest of the
        // screen had already settled with no sign it was still coming.
        val cancelDeferred = CompletableDeferred<Result<List<CancelRequestDto>>>()
        coEvery { visitRequestRepo.listCancelRequests(any()) } coAnswers { cancelDeferred.await() }

        val vm = buildViewModel()
        assertTrue(vm.state.value.visitRequestsLoading)

        cancelDeferred.complete(Result.success(emptyList()))
        advanceUntilIdle()

        assertFalse(vm.state.value.visitRequestsLoading)
    }

    @Test
    fun `a broken reschedule read cannot hide a cancellation that has been waiting since July`() =
        runTest(testDispatcher) {
            coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns
                Result.failure(IllegalStateException("permission-denied"))
            coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto()))

            val state = buildViewModel().state.value
            assertEquals(1, state.visitRequests.size)
            assertTrue(state.visitRequestsError!!.contains("permission-denied"))
        }

    @Test
    fun `a failed read is loud, so nobody reads silence as nothing waiting`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listCancelRequests(any()) } returns
            Result.failure(IllegalStateException("the office is offline"))

        val state = buildViewModel().state.value
        assertTrue(state.visitRequestsError!!.contains("Cancellation requests"))
    }

    @Test
    fun `the sandbox admin's expected denial paints no banner`() = runTest(testDispatcher) {
        // Stage-0I: these are cross-tenant reads a test admin cannot make. Same
        // rule the incoming-series stream already follows.
        coEvery { auntieRepo.isTestAdminActive() } returns true
        coEvery { visitRequestRepo.listCancelRequests(any()) } returns
            Result.failure(IllegalStateException("permission-denied"))

        assertNull(buildViewModel().state.value.visitRequestsError)
    }

    @Test
    fun `accepting a cancellation calls the cancellation callable and drops the row`() =
        runTest(testDispatcher) {
            coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto()))
            coEvery {
                visitRequestRepo.resolveCancellationRequest(any(), any(), any(), any(), any())
            } returns Result.success(
                ResolveBookingCancellationRequestResult(
                    ok = true,
                    visitId = "v1",
                    decision = "accept",
                    status = "cancelled",
                    sessionUpdated = true,
                    rescheduleRequestClosed = false,
                ),
            )

            val vm = buildViewModel()
            vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "accept")

            coVerify { visitRequestRepo.resolveCancellationRequest("fam-1", "b1", "v1", "accept", null) }
            assertTrue(vm.state.value.visitRequests.isEmpty())
            assertTrue(vm.state.value.visitRequestMessage!!.contains("off the schedule"))
        }

    @Test
    fun `accepting a visit with no schedule row says so rather than claiming both were written`() =
        runTest(testDispatcher) {
            coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto()))
            coEvery {
                visitRequestRepo.resolveCancellationRequest(any(), any(), any(), any(), any())
            } returns Result.success(
                ResolveBookingCancellationRequestResult(
                    ok = true,
                    visitId = "v1",
                    decision = "accept",
                    status = "cancelled",
                    sessionUpdated = false,
                    rescheduleRequestClosed = false,
                ),
            )

            val vm = buildViewModel()
            vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "accept")

            assertTrue(vm.state.value.visitRequestMessage!!.contains("no schedule row"))
        }

    @Test
    fun `accepting a reschedule calls the reschedule callable, not the cancellation one`() =
        runTest(testDispatcher) {
            coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns
                Result.success(listOf(rescheduleDto()))
            coEvery {
                visitRequestRepo.resolveRescheduleRequest(any(), any(), any(), any(), any())
            } returns Result.success(
                ResolveBookingRescheduleRequestResult(
                    ok = true,
                    visitId = "v2",
                    decision = "accept",
                    startTimeMs = 1_700_100_000_000L,
                    sessionUpdated = true,
                ),
            )

            val vm = buildViewModel()
            vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "accept")

            coVerify { visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null) }
            coVerify(exactly = 0) {
                visitRequestRepo.resolveCancellationRequest(any(), any(), any(), any(), any())
            }
        }

    @Test
    fun `a decline with no note still reaches the server, since the office does not owe a reason`() =
        runTest(testDispatcher) {
            coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto()))
            coEvery {
                visitRequestRepo.resolveCancellationRequest(any(), any(), any(), any(), any())
            } returns Result.success(
                ResolveBookingCancellationRequestResult(
                    ok = true,
                    visitId = "v1",
                    decision = "decline",
                    status = "confirmed",
                    sessionUpdated = false,
                    rescheduleRequestClosed = false,
                ),
            )

            val vm = buildViewModel()
            vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "decline", "   ")

            coVerify {
                visitRequestRepo.resolveCancellationRequest("fam-1", "b1", "v1", "decline", null)
            }
            assertTrue(vm.state.value.visitRequests.isEmpty())
        }

    @Test
    fun `a decline sends the trimmed reason`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto()))
        coEvery {
            visitRequestRepo.resolveCancellationRequest(any(), any(), any(), any(), any())
        } returns Result.success(
            ResolveBookingCancellationRequestResult(
                ok = true,
                visitId = "v1",
                decision = "decline",
                status = "confirmed",
                sessionUpdated = false,
                rescheduleRequestClosed = false,
            ),
        )

        val vm = buildViewModel()
        vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "decline", "  Inside the window.  ")

        coVerify {
            visitRequestRepo.resolveCancellationRequest("fam-1", "b1", "v1", "decline", "Inside the window.")
        }
        assertTrue(vm.state.value.visitRequests.isEmpty())
    }

    @Test
    fun `a refused decision keeps the row, because the household is still waiting`() =
        runTest(testDispatcher) {
            coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto()))
            coEvery {
                visitRequestRepo.resolveCancellationRequest(any(), any(), any(), any(), any())
            } returns Result.failure(
                IllegalStateException("There is no cancellation request waiting on this visit."),
            )

            val vm = buildViewModel()
            vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "accept")

            assertEquals(1, vm.state.value.visitRequests.size)
            assertTrue(vm.state.value.visitRequestsError!!.contains("no cancellation request"))
            assertNull(vm.state.value.visitRequestKey)
        }

    // ── #1100: accepting a reschedule runs the busy and overlap guards ────────
    private val movedResult = ResolveBookingRescheduleRequestResult(
        ok = true,
        visitId = "v2",
        decision = "accept",
        startTimeMs = 1_700_100_000_000L,
        sessionUpdated = true,
    )
    private fun accept(vm: EnhancedSchedulingViewModel) =
        vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "accept")
    @Test
    fun `a busy clash on accepting keeps the row, offers the override, and Accept anyway resends with it`() =
        runTest(testDispatcher) {
            coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(listOf(rescheduleDto()))
            coEvery { visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null, false, false) } returns
                Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "Busy block then."))
            coEvery { visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null, true, false) } returns
                Result.success(movedResult)
            val vm = buildViewModel()
            accept(vm)
            assertEquals(1, vm.state.value.visitRequests.size)
            assertEquals(ScheduleOverrideKind.BUSY, vm.state.value.visitRequestOverride)
            assertTrue(vm.state.value.visitRequestsError!!.contains("Busy block then."))
            vm.retryVisitRequestWithOverride()
            coVerify(exactly = 1) {
                visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null, true, false)
            }
            assertTrue(vm.state.value.visitRequests.isEmpty())
            assertNull(vm.state.value.visitRequestOverride)
            assertNull(vm.state.value.visitRequestsError)
            assertTrue(vm.state.value.visitRequestMessage!!.startsWith("Moved"))
        }
    @Test
    fun `a visit clash after a busy override resends with both`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(listOf(rescheduleDto()))
        coEvery { visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null, false, false) } returns
            Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "Busy block then."))
        coEvery { visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null, true, false) } returns
            Result.failure(BookingRequestRefusedException(VISIT_OVERLAP_CONFLICT_CODE, "Another visit then."))
        coEvery { visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null, true, true) } returns
            Result.success(movedResult)
        val vm = buildViewModel()
        accept(vm)
        vm.retryVisitRequestWithOverride()
        assertEquals(ScheduleOverrideKind.VISIT, vm.state.value.visitRequestOverride)
        vm.retryVisitRequestWithOverride()
        coVerify(exactly = 1) {
            visitRequestRepo.resolveRescheduleRequest("fam-2", "b2", "v2", "accept", null, true, true)
        }
        assertTrue(vm.state.value.visitRequests.isEmpty())
    }
    @Test
    fun `a company closure on accepting offers no override`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(listOf(rescheduleDto()))
        coEvery { visitRequestRepo.resolveRescheduleRequest(any(), any(), any(), any(), any(), any(), any()) } returns
            Result.failure(BookingRequestRefusedException("company_holiday_conflict", "Tribe Tails is closed that day."))
        val vm = buildViewModel()
        accept(vm)
        assertNull(vm.state.value.visitRequestOverride)
        assertTrue(vm.state.value.visitRequestsError!!.contains("closed that day"))
        assertEquals(1, vm.state.value.visitRequests.size)
        // With nothing offered, a stray retry sends nothing.
        vm.retryVisitRequestWithOverride()
        coVerify(exactly = 1) {
            visitRequestRepo.resolveRescheduleRequest(any(), any(), any(), any(), any(), any(), any())
        }
    }
    @Test
    fun `a declined reschedule never offers an override`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(listOf(rescheduleDto()))
        coEvery { visitRequestRepo.resolveRescheduleRequest(any(), any(), any(), any(), any(), any(), any()) } returns
            Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "Busy block then."))
        val vm = buildViewModel()
        vm.resolveVisitRequest(vm.state.value.visitRequests.single(), "decline")
        assertNull(vm.state.value.visitRequestOverride)
    }
    @Test
    fun `dismissing the error withdraws the offered override`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(listOf(rescheduleDto()))
        coEvery { visitRequestRepo.resolveRescheduleRequest(any(), any(), any(), any(), any(), any(), any()) } returns
            Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "Busy block then."))
        val vm = buildViewModel()
        accept(vm)
        vm.clearVisitRequestsError()
        vm.retryVisitRequestWithOverride()
        assertNull(vm.state.value.visitRequestOverride)
        coVerify(exactly = 1) {
            visitRequestRepo.resolveRescheduleRequest(any(), any(), any(), any(), any(), any(), any())
        }
    }
    // ── #1098: an incoming Overnight waits for the operator's start time ──────

    private val nightOf9th = IncomingKinCare(
        familyId = "kf1", batchId = "b1", visitId = "night-1", kinfolkId = "kf1",
        kinfolkName = "Jane Doe", serviceType = "Overnight", serviceId = "Overnight",
        status = "requested", startTimePending = true, requestedDate = "2026-10-09",
    )

    /** 7:30 PM on Oct 9 in the business zone (America/Chicago, CDT) is 00:30 UTC on Oct 10. */
    private val startMs = Instant.parse("2026-10-10T00:30:00Z").toEpochMilli()

    private fun seedOvernight() {
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(listOf(nightOf9th)))
        coEvery { auntieRepo.getBusinessSettings() } returns
            Result.success(BusinessSettings().apply { timeZone = "America/Chicago" })
    }

    @Test
    fun `an Overnight with no start time is not approved, and the call is never made`() = runTest(testDispatcher) {
        seedOvernight()
        coEvery { auntieRepo.manageBookingSeries(any(), any(), any(), any(), any(), any()) } returns
            Result.success(ManageSeriesResult(affectedVisits = 1))
        val vm = buildViewModel()
        val series = vm.state.value.incomingSeries.single()

        assertFalse(seriesReadyToApprove(series, vm.state.value.seriesStartTimes))
        vm.approveSeries(series)

        coVerify(exactly = 0) { auntieRepo.manageBookingSeries(any(), any(), any(), any(), any(), any()) }
        assertEquals("Set the start time for each night before approving.", vm.state.value.incomingError)
    }

    @Test
    fun `approving sends the start time as an instant in the business zone`() = runTest(testDispatcher) {
        seedOvernight()
        coEvery { auntieRepo.manageBookingSeries(any(), any(), any(), any(), any(), any()) } returns
            Result.success(ManageSeriesResult(affectedVisits = 1, newlyConfirmed = 1, householdNotified = true))
        val vm = buildViewModel()
        val series = vm.state.value.incomingSeries.single()

        vm.setSeriesStartTime(series, "night-1", LocalTime.of(19, 30))
        assertTrue(seriesReadyToApprove(series, vm.state.value.seriesStartTimes))
        vm.approveSeries(series)

        coVerify(exactly = 1) {
            auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", mapOf("night-1" to startMs), false, false)
        }
        assertNull(vm.state.value.incomingError)
        assertTrue(vm.state.value.seriesActionMessage!!.startsWith("Approved"))
    }

    @Test
    fun `a busy clash offers the override, and Approve anyway resends with it`() = runTest(testDispatcher) {
        seedOvernight()
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", any(), false, false) } returns
            Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "Busy block then."))
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", any(), true, false) } returns
            Result.success(ManageSeriesResult(affectedVisits = 1, newlyConfirmed = 1, householdNotified = true))
        val vm = buildViewModel()
        val series = vm.state.value.incomingSeries.single()
        vm.setSeriesStartTime(series, "night-1", LocalTime.of(19, 30))

        vm.approveSeries(series)
        assertEquals(ScheduleOverrideKind.BUSY, vm.state.value.incomingOverride)
        assertTrue(vm.state.value.incomingError!!.contains("Busy block then."))

        vm.retryIncomingWithOverride()

        coVerify(exactly = 1) {
            auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", mapOf("night-1" to startMs), true, false)
        }
        assertNull(vm.state.value.incomingOverride)
        assertTrue(vm.state.value.seriesActionMessage!!.startsWith("Approved"))
    }

    @Test
    fun `a visit clash after a busy override on a reschedule accept resends with both`() = runTest(testDispatcher) {
        seedOvernight()
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", any(), false, false) } returns
            Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "Busy block then."))
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", any(), true, false) } returns
            Result.failure(BookingRequestRefusedException(VISIT_OVERLAP_CONFLICT_CODE, "Another visit then."))
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", any(), true, true) } returns
            Result.success(ManageSeriesResult(affectedVisits = 1, newlyConfirmed = 1, householdNotified = true))
        val vm = buildViewModel()
        val series = vm.state.value.incomingSeries.single()
        vm.setSeriesStartTime(series, "night-1", LocalTime.of(19, 30))

        vm.approveSeries(series)
        vm.retryIncomingWithOverride()
        assertEquals(ScheduleOverrideKind.VISIT, vm.state.value.incomingOverride)
        vm.retryIncomingWithOverride()

        coVerify(exactly = 1) {
            auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", mapOf("night-1" to startMs), true, true)
        }
    }

    @Test
    fun `a refusal with no override offers none`() = runTest(testDispatcher) {
        seedOvernight()
        coEvery { auntieRepo.manageBookingSeries(any(), any(), any(), any(), any(), any()) } returns
            Result.failure(BookingRequestRefusedException(null, "The start time has to be on Fri, Oct 9."))
        val vm = buildViewModel()
        val series = vm.state.value.incomingSeries.single()
        vm.setSeriesStartTime(series, "night-1", LocalTime.of(19, 30))

        vm.approveSeries(series)

        assertNull(vm.state.value.incomingOverride)
        assertTrue(vm.state.value.incomingError!!.contains("has to be on Fri, Oct 9"))
    }

    @Test
    fun `changing the time drops an override granted for the old one`() = runTest(testDispatcher) {
        seedOvernight()
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", any(), false, false) } returns
            Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "Busy block then."))
        coEvery { auntieRepo.manageBookingSeries("APPROVE", "kf1", "b1", any(), true, false) } returns
            Result.failure(BookingRequestRefusedException(VISIT_OVERLAP_CONFLICT_CODE, "Another visit then."))
        val vm = buildViewModel()
        val series = vm.state.value.incomingSeries.single()
        vm.setSeriesStartTime(series, "night-1", LocalTime.of(19, 30))
        vm.approveSeries(series)
        vm.retryIncomingWithOverride()

        vm.setSeriesStartTime(series, "night-1", LocalTime.of(21, 0))
        assertNull(vm.state.value.incomingOverride)
        vm.approveSeries(series)

        coVerify(exactly = 1) {
            auntieRepo.manageBookingSeries(
                "APPROVE", "kf1", "b1",
                mapOf("night-1" to Instant.parse("2026-10-10T02:00:00Z").toEpochMilli()),
                false, false,
            )
        }
    }
}
