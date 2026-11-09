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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1576: the Schedule's visit sheet offers Mark Completed beside Cancel, as
 * web Bookings does. The visit is the linked session, completed through the
 * callable; the envelope follows with a status-only patch.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelMarkCompletedTest {

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
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        coEvery { auntieRepo.isTestAdminActive() } returns false
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
        coEvery { bookingRepo.updateBookingStatus(any(), any()) } returns Result.success(Unit)
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
        kinfolkName = "The Wrens",
        startDateTime = "2026-06-02T10:00:00",
        endDateTime = "2026-06-02T11:00:00",
        status = BookingStatus.ACCEPTED,
    )

    private fun linked(vararg ids: String) {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns
            Result.success(ids.map { KinCareSession(id = it, kinfolkId = "kf1", status = "SCHEDULED") })
    }

    @Test
    fun `completes the linked session through the callable, then the envelope's status only`() = runTest(testDispatcher) {
        linked("s1")
        coEvery { kinCareRepo.markSessionComplete("s1") } returns Result.success(Unit)

        val vm = buildViewModel()
        vm.markBookingCompleted(booking())

        coVerify(exactly = 1) { kinCareRepo.markSessionComplete("s1") }
        coVerify(exactly = 1) { bookingRepo.updateBookingStatus("b1", BookingStatus.COMPLETED) }
        // Never the whole-model rebuild.
        coVerify(exactly = 0) { bookingRepo.updateBooking(any()) }
        assertEquals("The Wrens's visit is marked Completed.", vm.state.value.bookingActionMessage)
        assertNull(vm.state.value.errorMessage)
    }

    @Test
    fun `a refusal is shown in the server's words and nothing else moves`() = runTest(testDispatcher) {
        linked("s1")
        coEvery { kinCareRepo.markSessionComplete("s1") } returns
            Result.failure(RuntimeException("This visit has no arrival and departure recorded."))

        val vm = buildViewModel()
        vm.markBookingCompleted(booking())

        assertEquals("This visit has no arrival and departure recorded.", vm.state.value.errorMessage)
        coVerify(exactly = 0) { bookingRepo.updateBookingStatus(any(), any()) }
    }

    @Test
    fun `no linked visit, or two, is refused by name rather than guessed`() = runTest(testDispatcher) {
        linked()
        val vm = buildViewModel()
        vm.markBookingCompleted(booking())
        assertTrue(vm.state.value.errorMessage.orEmpty().contains("No scheduled visit is linked"))

        linked("s1", "s2")
        vm.markBookingCompleted(booking())
        assertTrue(vm.state.value.errorMessage.orEmpty().contains("2 visits linked"))
        coVerify(exactly = 0) { kinCareRepo.markSessionComplete(any()) }
    }
}
