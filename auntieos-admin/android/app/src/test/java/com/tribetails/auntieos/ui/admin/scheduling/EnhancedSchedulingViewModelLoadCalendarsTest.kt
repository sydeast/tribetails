package com.tribetails.auntieos.ui.admin.scheduling
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.GoogleCalendarListResult
import com.tribetails.auntieos.data.repository.GoogleCalendarSummary
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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
 * #1661: Load calendars shows a wait and cannot be tapped twice. The in-flight
 * flag mirrors savingTargets and pushing: set before the call, cleared on
 * success and on failure, and a second call while set makes no request.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelLoadCalendarsTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private val listed = GoogleCalendarListResult(
        calendars = listOf(GoogleCalendarSummary("primary", "Auntie", "owner", true)),
        connection = GoogleCalendarConnection(connected = true),
        freeBusyCalendarId = "primary",
    )
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
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
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
    fun `the flag is true while the call is in flight and clears on success`() = runTest(testDispatcher) {
        val gate = CompletableDeferred<Result<GoogleCalendarListResult>>()
        coEvery { bookingRepo.listGoogleCalendars() } coAnswers { gate.await() }
        val vm = buildViewModel()
        vm.refreshGoogleCalendars()
        assertTrue(vm.state.value.googleCalendar.loadingCalendars)
        gate.complete(Result.success(listed))
        val after = vm.state.value.googleCalendar
        assertFalse(after.loadingCalendars)
        assertEquals(listed.calendars, after.calendars)
        assertNull(after.error)
    }
    @Test
    fun `a second call while in flight makes no second request`() = runTest(testDispatcher) {
        val gate = CompletableDeferred<Result<GoogleCalendarListResult>>()
        coEvery { bookingRepo.listGoogleCalendars() } coAnswers { gate.await() }
        val vm = buildViewModel()
        vm.refreshGoogleCalendars()
        vm.refreshGoogleCalendars()
        vm.refreshGoogleCalendars()
        gate.complete(Result.success(listed))
        coVerify(exactly = 1) { bookingRepo.listGoogleCalendars() }
    }
    @Test
    fun `the flag clears on failure and the error shows`() = runTest(testDispatcher) {
        coEvery { bookingRepo.listGoogleCalendars() } returns Result.failure(RuntimeException("Google said no"))
        val vm = buildViewModel()
        vm.refreshGoogleCalendars()
        val after = vm.state.value.googleCalendar
        assertFalse(after.loadingCalendars)
        assertEquals("Google said no", after.error)
        assertTrue(after.calendars.isEmpty())
    }
    @Test
    fun `a failure with no message falls back to the default text`() = runTest(testDispatcher) {
        coEvery { bookingRepo.listGoogleCalendars() } returns Result.failure(RuntimeException())
        val vm = buildViewModel()
        vm.refreshGoogleCalendars()
        assertEquals("Couldn't list the calendars on this account.", vm.state.value.googleCalendar.error)
    }
    @Test
    fun `after a failure the next tap makes a fresh request`() = runTest(testDispatcher) {
        coEvery { bookingRepo.listGoogleCalendars() } returnsMany listOf(
            Result.failure(RuntimeException("boom")),
            Result.success(listed),
        )
        val vm = buildViewModel()
        vm.refreshGoogleCalendars()
        vm.refreshGoogleCalendars()
        coVerify(exactly = 2) { bookingRepo.listGoogleCalendars() }
        val after = vm.state.value.googleCalendar
        assertFalse(after.loadingCalendars)
        assertNull(after.error)
        assertEquals(1, after.calendars.size)
    }
}
