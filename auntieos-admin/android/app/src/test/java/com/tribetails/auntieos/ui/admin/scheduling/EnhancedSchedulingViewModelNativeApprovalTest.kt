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
import org.junit.Before
import org.junit.Test

/**
 * #1630: approving an Android-native booking (`enhanced_bookings`, no MyTribe
 * request behind it) makes its visit through the `createKinCareSession`
 * callable, which writes the booking record too, so the visit can be given an
 * Auntie and notes. It used to write `kin_care_sessions` directly with no
 * record, and the visit read "This visit is not part of a booking request" on
 * every client.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelNativeApprovalTest {

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
        auntieRepo = mockk(relaxed = true)
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
        coEvery { bookingRepo.updateBooking(any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId(any()) } returns Result.success(emptyList())
        coEvery {
            kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.success("vis_enh_eb1")
        coEvery { kinCareRepo.createKinCareSession(any<KinCareSession>()) } returns Result.success("ses-direct")
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** #1702: a fixed clock ahead of [booking]'s start, so approval is not judged on the real date. */
    private val beforeTheVisit = java.time.Clock.fixed(java.time.Instant.parse("2026-11-01T15:00:00Z"), java.time.ZoneOffset.UTC)
    private fun buildViewModel(clock: java.time.Clock = beforeTheVisit) = EnhancedSchedulingViewModel(
        bookingRepository = bookingRepo,
        serviceRepository = serviceRepo,
        auntieRepository = auntieRepo,
        kinCareRepository = kinCareRepo,
        clock = clock,
    )

    private fun booking() = EnhancedBooking(
        id = "eb1",
        kinfolkId = "kf1",
        kinfolkName = "The Wrens",
        title = "Dog Walk",
        startDateTime = "2026-12-02T10:00:00",
        endDateTime = "2026-12-02T10:30:00",
        status = BookingStatus.DRAFT,
        notes = "Gate code is on the fridge",
    )

    @Test
    fun `a native booking is approved through the callable, carrying its own id`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.approveBooking(booking())

        coVerify(exactly = 1) {
            kinCareRepo.createKinCareSession(
                kinfolkId = "kf1",
                kinIds = any(),
                serviceType = "Dog Walk",
                startTime = "2026-12-02T10:00:00",
                endTime = "2026-12-02T10:30:00",
                serviceDurationMinutes = 30,
                notes = "Gate code is on the fridge",
                enhancedBookingId = "eb1",
            )
        }
        // The direct write that made a visit with no booking record is gone for it.
        coVerify(exactly = 0) { kinCareRepo.createKinCareSession(any<KinCareSession>()) }
    }

    @Test
    fun `a booking that already has its visit is not approved into a second one`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("eb1") } returns
            Result.success(listOf(KinCareSession(id = "vis_enh_eb1", kinfolkId = "kf1", status = "SCHEDULED")))
        val vm = buildViewModel()
        vm.approveBooking(booking())

        coVerify(exactly = 0) { kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any(), any()) }
        coVerify(exactly = 0) { kinCareRepo.createKinCareSession(any<KinCareSession>()) }
    }

    // #1702: operator ruling for #1574, a past-dated visit only as already
    // Completed, never Scheduled. The booking used to flip to approved and only
    // its session was refused; now nothing is written.
    @Test
    fun `a booking whose start has passed is refused before anything is written`() = runTest(testDispatcher) {
        val afterTheVisit = java.time.Clock.fixed(java.time.Instant.parse("2026-12-02T18:00:00Z"), java.time.ZoneOffset.UTC)
        val vm = buildViewModel(afterTheVisit)
        vm.approveBooking(booking())
        assertEquals(com.tribetails.auntieos.domain.APPROVE_IN_PAST_MESSAGE, vm.state.value.errorMessage)
        coVerify(exactly = 0) { bookingRepo.updateBooking(any()) }
        coVerify(exactly = 0) { kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any(), any()) }
        coVerify(exactly = 0) { kinCareRepo.createKinCareSession(any<KinCareSession>()) }
    }
}
