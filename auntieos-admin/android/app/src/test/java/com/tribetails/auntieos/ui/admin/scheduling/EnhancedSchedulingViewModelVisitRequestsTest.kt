package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.CancelRequestDto
import com.tribetails.auntieos.data.contracts.RescheduleRequestDto
import com.tribetails.auntieos.data.contracts.ResolveBookingCancellationRequestResult
import com.tribetails.auntieos.data.contracts.ResolveBookingRescheduleRequestResult
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
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
}
