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
import com.tribetails.auntieos.domain.RESCHEDULE_IN_PAST_MESSAGE
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
import org.junit.Before
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset

/**
 * #1574, operator ruling 2026-11-05: a visit created with a past date is
 * allowed only as already Completed, never Scheduled; moving an existing visit
 * into the past stays blocked.
 *
 * The clock stands at 2026-06-02 17:00Z, which is 12:00 on the business clock
 * (America/Chicago, the shared fallback, CDT). The fixtures are wall clocks on
 * that same clock, as this screen types and sends them.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelPastVisitTest {

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
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
        coEvery { bookingRepo.updateBookingTimes(any(), any(), any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns
            Result.success(listOf(KinCareSession(id = "s1", kinfolkId = "kf1", status = "SCHEDULED")))
        coEvery { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) } returns Result.success(Unit)
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
        clock = Clock.fixed(Instant.parse("2026-06-02T17:00:00Z"), ZoneOffset.UTC),
    )

    private fun booking() = EnhancedBooking(
        id = "b1",
        kinfolkId = "kf1",
        kinfolkName = "The Mendozas",
        startDateTime = "2026-06-02T15:00:00",
        endDateTime = "2026-06-02T16:00:00",
        status = BookingStatus.ACCEPTED,
    )

    @Test
    fun `now is read on the business clock`() {
        assertEquals(LocalDateTime.parse("2026-06-02T12:00:00"), buildViewModel().businessNow())
    }

    @Test
    fun `a move onto an hour that has passed is refused by name and never sent`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.selectBooking(booking())
        vm.rescheduleSelectedBooking("2026-06-02", "11:00")

        coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
        assertEquals(RESCHEDULE_IN_PAST_MESSAGE, vm.state.value.scheduleWriteError)
    }

    @Test
    fun `a move to an hour still ahead is sent as before`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.selectBooking(booking())
        vm.rescheduleSelectedBooking("2026-06-02", "13:00")

        coVerify(exactly = 1) {
            kinCareRepo.rescheduleBooking("s1", "2026-06-02T13:00:00", "2026-06-02T14:00:00", false, false)
        }
    }

    @Test
    fun `recording a past visit sends recordAsCompleted with the UTC instants and says so`() = runTest(testDispatcher) {
        coEvery {
            kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.success("sess-9")

        val vm = buildViewModel()
        vm.recordCompletedVisit(
            kinfolkId = "kf1",
            kinfolkName = "The Mendozas",
            serviceType = "30Minute",
            startUtcIso = "2026-05-20T14:00:00Z",
            endUtcIso = "2026-05-20T14:30:00Z",
            durationMinutes = 30,
            notes = "",
        )

        coVerify(exactly = 1) {
            kinCareRepo.createKinCareSession(
                "kf1", emptyList(), "30Minute", "2026-05-20T14:00:00Z", "2026-05-20T14:30:00Z", 30, "", true,
            )
        }
        assertEquals("The Mendozas's visit is recorded as completed.", vm.state.value.bookingActionMessage)
    }

    @Test
    fun `a refusal from the server is shown in its own words`() = runTest(testDispatcher) {
        coEvery {
            kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.failure(RuntimeException("That visit has not happened yet, so it cannot be recorded as completed. Schedule it instead."))

        val vm = buildViewModel()
        vm.recordCompletedVisit("kf1", "The Mendozas", "30Minute", "2026-06-03T14:00:00Z", "2026-06-03T14:30:00Z", 30, "")

        assertEquals(
            "That visit has not happened yet, so it cannot be recorded as completed. Schedule it instead.",
            vm.state.value.errorMessage,
        )
    }
}
