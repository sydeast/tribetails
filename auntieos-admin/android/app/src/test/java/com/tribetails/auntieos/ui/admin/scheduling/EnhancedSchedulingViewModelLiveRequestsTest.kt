package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.CancelRequestDto
import com.tribetails.auntieos.data.contracts.RescheduleRequestDto
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.IncomingKinCare
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
import kotlinx.coroutines.flow.MutableSharedFlow
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
 * #1864, #2069, #2028 on the Bookings screen's view model.
 *
 * #1864: the move and cancel asks were read once, when the screen opened, so a
 * new ask filed while it stayed open never arrived. A live change signal now
 * reads them again, without blanking what is on screen.
 *
 * #2069: the Notifications screen answers a request only while the live
 * request queue is known to be current (`incomingLive`).
 *
 * #2028: a notification's Open names the request whose sheet opens here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelLiveRequestsTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private lateinit var visitRequestRepo: VisitRequestRepository
    private lateinit var askChanges: MutableSharedFlow<Unit>

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        bookingRepo = mockk()
        serviceRepo = mockk()
        auntieRepo = mockk()
        kinCareRepo = mockk()
        visitRequestRepo = mockk()
        askChanges = MutableSharedFlow()

        coEvery { serviceRepo.getBaseServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        coEvery { auntieRepo.isTestAdminActive() } returns false
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.visitAskChangesStream() } returns askChanges
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

    private fun cancelDto(visitId: String) = CancelRequestDto(
        kinfolkId = "fam-1", batchId = "b1", visitId = visitId, kinfolkName = "The Devlins",
        title = "Evening sit", serviceType = "Pet Sitting", kinNames = listOf("Nutmeg"), status = "confirmed",
        startTimeMs = 1_700_000_000_000L, endTimeMs = null, reason = "We are away", requestedAtMs = 100L,
    )

    private fun rescheduleDto(visitId: String) = RescheduleRequestDto(
        kinfolkId = "fam-2", batchId = "b2", visitId = visitId, kinfolkName = "The Wrens",
        title = "Morning drop-in", serviceType = "Drop-in Visit", kinNames = listOf("Biscuit"), status = "confirmed",
        currentStartTimeMs = 1_700_000_000_000L, currentEndTimeMs = null,
        proposedStartTimeMs = 1_700_100_000_000L, proposedEndTimeMs = null,
        reason = "Flight moved", requestedAtMs = 200L,
    )

    @Test
    fun `a new ask filed while the screen is open arrives on the live signal`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listCancelRequests(any()) } returns Result.success(listOf(cancelDto("v1")))
        val vm = buildViewModel()
        advanceUntilIdle()
        assertEquals(1, vm.state.value.visitRequests.size)

        coEvery { visitRequestRepo.listCancelRequests(any()) } returns
            Result.success(listOf(cancelDto("v1"), cancelDto("v9")))
        askChanges.emit(Unit)
        advanceUntilIdle()

        assertEquals(2, vm.state.value.visitRequests.size)
        coVerify(exactly = 2) { visitRequestRepo.listCancelRequests(any()) }
    }

    @Test
    fun `the re-read keeps the rows on screen while it is out`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(listOf(rescheduleDto("v2")))
        val vm = buildViewModel()
        advanceUntilIdle()

        val gate = CompletableDeferred<Unit>()
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } coAnswers {
            gate.await()
            Result.success(listOf(rescheduleDto("v2")))
        }
        askChanges.emit(Unit)
        // In flight: never the loading panel, never an empty list.
        assertFalse(vm.state.value.visitRequestsLoading)
        assertEquals(1, vm.state.value.visitRequests.size)
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(1, vm.state.value.visitRequests.size)
    }

    @Test
    fun `a failed re-read keeps that queue's rows and says it failed`() = runTest(testDispatcher) {
        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.success(listOf(rescheduleDto("v2")))
        val vm = buildViewModel()
        advanceUntilIdle()

        coEvery { visitRequestRepo.listRescheduleRequests(any()) } returns Result.failure(IllegalStateException("offline"))
        askChanges.emit(Unit)
        advanceUntilIdle()

        assertEquals(1, vm.state.value.visitRequests.size)
        assertTrue(vm.state.value.visitRequestsError.orEmpty().contains("Reschedule requests: offline"))
    }

    @Test
    fun `a test admin starts no signal`() = runTest(testDispatcher) {
        coEvery { auntieRepo.isTestAdminActive() } returns true
        buildViewModel()
        advanceUntilIdle()
        io.mockk.verify(exactly = 0) { bookingRepo.visitAskChangesStream() }
    }

    @Test
    fun `a signal that cannot start is never shown`() = runTest(testDispatcher) {
        every { bookingRepo.visitAskChangesStream() } throws IllegalStateException("no index")
        val vm = buildViewModel()
        advanceUntilIdle()
        assertNull(vm.state.value.visitRequestsError)
        assertFalse(vm.state.value.visitRequestsLoading)
    }

    @Test
    fun `the request queue is live after a good read and not after a failed one`() = runTest(testDispatcher) {
        val incoming = MutableSharedFlow<Result<List<IncomingKinCare>>>()
        every { bookingRepo.incomingKinCareRequestsStream() } returns incoming
        val vm = buildViewModel()
        advanceUntilIdle()
        assertFalse("unknown before its first answer", vm.state.value.incomingLive)

        incoming.emit(
            Result.success(
                listOf(
                    IncomingKinCare(
                        familyId = "kf1", batchId = "req_1", visitId = "v1", kinfolkId = "kf1",
                        startTime = "2026-12-03T15:00:00Z", status = "requested",
                    ),
                ),
            ),
        )
        assertTrue(vm.state.value.incomingLive)
        assertEquals(listOf("kf1/req_1"), vm.state.value.incomingSeries.map { it.requestKey })

        incoming.emit(Result.failure(IllegalStateException("denied")))
        assertFalse(vm.state.value.incomingLive)
    }

    @Test
    fun `a notification's Open names the request, and opening its sheet clears it`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.focusIncomingRequest("kf1", "req_1")
        assertEquals("kf1/req_1", vm.state.value.focusedRequestKey)
        vm.clearFocusedRequest()
        assertNull(vm.state.value.focusedRequestKey)
    }
}
