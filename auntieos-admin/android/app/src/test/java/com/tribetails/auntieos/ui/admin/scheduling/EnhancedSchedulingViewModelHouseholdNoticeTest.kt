package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.HouseholdNoticeDto
import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.domain.HouseholdNoticePreview
import com.tribetails.auntieos.domain.householdNoticeConfirmLine
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
import org.junit.Before
import org.junit.Test
import java.time.LocalDateTime

/**
 * #1838 (cancel), #2027 (move and drag), #1841 (New Booking confirmed at once):
 * the Android schedule asks the server who a household notice will reach
 * before the action, and says what the server did after it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelHouseholdNoticeTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private val previewCalls = mutableListOf<Triple<String, String, String?>>()
    private var previewAnswer: Result<HouseholdNoticePreview.Ready> =
        Result.success(HouseholdNoticePreview.Ready(true, null, "Dre East", listOf("email")))

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
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings(enableConflictDetection = false))
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { auntieRepo.isCurrentUserOwner() } returns Result.success(true)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
        coEvery { bookingRepo.updateBooking(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.updateBookingTimes(any(), any(), any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns
            Result.success(listOf(KinCareSession(id = "s1", kinfolkId = "kf1", status = "SCHEDULED")))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = EnhancedSchedulingViewModel(
        bookingRepository = bookingRepo,
        serviceRepository = serviceRepo,
        auntieRepository = auntieRepo,
        kinCareRepository = kinCareRepo,
        clock = java.time.Clock.fixed(java.time.Instant.parse("2026-01-01T00:00:00Z"), java.time.ZoneOffset.UTC),
        householdPreviewer = { familyId, key, sessionId ->
            previewCalls += Triple(familyId, key, sessionId)
            previewAnswer
        },
    )

    private fun booking() = EnhancedBooking(
        id = "b1",
        kinfolkId = "kf1",
        kinfolkName = "The Wrens",
        startDateTime = "2026-06-02T10:00:00",
        endDateTime = "2026-06-02T11:00:00",
        status = BookingStatus.ACCEPTED,
    )

    private val told = HouseholdNoticeDto(told = true, reason = null, name = "Dre East", channels = listOf("email"))

    // ── #1838: cancel ────────────────────────────────────────────────────────

    @Test
    fun `HAPPY cancel asks first, names who will be told, and the message says who was`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.cancelSession(any(), any()) } returns Result.success(told)
        val vm = vm()
        vm.requestCancel(booking())
        coVerify(exactly = 0) { kinCareRepo.cancelSession(any(), any()) }
        assertEquals(Triple("kf1", "kincare.booking.cancel", "s1"), previewCalls.single())
        assertEquals("Dre East will get an email.", householdNoticeConfirmLine(vm.state.value.cancelPreview, "The Wrens"))
        vm.confirmCancel()
        assertEquals("The Wrens's visit is cancelled. Dre East was sent an email.", vm.state.value.bookingActionMessage)
    }

    @Test
    fun `SAD notices off nobody will be told, and the message says nobody was`() = runTest(testDispatcher) {
        previewAnswer = Result.success(HouseholdNoticePreview.Ready(false, "household_notices_off", "Dre East", emptyList()))
        coEvery { kinCareRepo.cancelSession(any(), any()) } returns
            Result.success(HouseholdNoticeDto(false, "household_notices_off", "Dre East", emptyList()))
        val vm = vm()
        vm.requestCancel(booking())
        assertEquals(
            "Nobody will be told: notices to households are off in Settings.",
            householdNoticeConfirmLine(vm.state.value.cancelPreview, "The Wrens", vm.state.value.auntieSignedIn),
        )
        vm.confirmCancel()
        assertEquals(
            "The Wrens's visit is cancelled. Nobody was told: notices to households are off in Settings.",
            vm.state.value.bookingActionMessage,
        )
    }

    @Test
    fun `NEGATIVE Back on the cancel question cancels nothing`() = runTest(testDispatcher) {
        val vm = vm()
        vm.requestCancel(booking())
        vm.dismissCancel()
        assertNull(vm.state.value.pendingCancel)
        coVerify(exactly = 0) { kinCareRepo.cancelSession(any(), any()) }
        coVerify(exactly = 0) { bookingRepo.updateBooking(any()) }
    }

    @Test
    fun `NEGATIVE an Auntie is told who can change the switch, not sent to Settings`() = runTest(testDispatcher) {
        coEvery { auntieRepo.isCurrentUserOwner() } returns Result.success(false)
        previewAnswer = Result.success(HouseholdNoticePreview.Ready(false, "household_notices_off", "Dre East", emptyList()))
        val vm = vm()
        vm.requestCancel(booking())
        assertEquals(
            "Nobody will be told: the owner has notices to households turned off.",
            householdNoticeConfirmLine(vm.state.value.cancelPreview, "The Wrens", vm.state.value.auntieSignedIn),
        )
    }

    @Test
    fun `ERROR an older server with no notice, the message claims nothing about the household`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.cancelSession(any(), any()) } returns Result.success(null)
        previewAnswer = Result.failure(RuntimeException("offline"))
        val vm = vm()
        vm.requestCancel(booking())
        assertNull(householdNoticeConfirmLine(vm.state.value.cancelPreview, "The Wrens"))
        vm.confirmCancel()
        assertEquals("The Wrens's visit is cancelled.", vm.state.value.bookingActionMessage)
    }

    @Test
    fun `NEGATIVE a booking with no linked visit says nobody will be told, and nobody was`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns Result.success(emptyList())
        val vm = vm()
        vm.requestCancel(booking())
        assertEquals(
            "Nobody will be told: this visit is not linked to a booking.",
            householdNoticeConfirmLine(vm.state.value.cancelPreview, "The Wrens"),
        )
        assertEquals(0, previewCalls.size)
        vm.confirmCancel()
        assertEquals(
            "The Wrens's visit is cancelled. Nobody was told: this visit is not linked to a booking.",
            vm.state.value.bookingActionMessage,
        )
    }
    // ── #2027: drag and move ─────────────────────────────────────────────────

    @Test
    fun `HAPPY a drag asks first, and the move says who it told`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) } returns Result.success(told)
        val vm = vm()
        vm.startDragBooking(booking(), LocalDateTime.parse("2026-06-02T10:00:00"))
        vm.updateDragPosition(LocalDateTime.parse("2026-06-02T13:30:00"))
        vm.completeDrag()
        coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
        assertEquals("kincare.changed", previewCalls.last().second)
        assertEquals("Dre East will get an email.", householdNoticeConfirmLine(vm.state.value.movePreview, "The Wrens"))
        vm.confirmMove()
        assertEquals("The Wrens's visit is rescheduled. Dre East was sent an email.", vm.state.value.bookingActionMessage)
    }

    @Test
    fun `SAD Keep it where it was writes nothing and releases the drag`() = runTest(testDispatcher) {
        val vm = vm()
        vm.startDragBooking(booking(), LocalDateTime.parse("2026-06-02T10:00:00"))
        vm.updateDragPosition(LocalDateTime.parse("2026-06-02T13:30:00"))
        vm.completeDrag()
        vm.dismissMove()
        assertNull(vm.state.value.pendingMove)
        assertNull(vm.state.value.dragState)
        coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `the Reschedule form names who a move would tell, for the visit selected`() = runTest(testDispatcher) {
        previewAnswer = Result.success(HouseholdNoticePreview.Ready(false, "not_a_household_notice", "Dre East", emptyList()))
        val vm = vm()
        vm.selectBooking(booking())
        assertEquals(
            "No notice goes to Dre East for this.",
            householdNoticeConfirmLine(vm.state.value.selectedMovePreview, "The Wrens"),
        )
        assertEquals(Triple("kf1", "kincare.changed", "s1"), previewCalls.single())
    }

    // ── #1841: New Booking confirmed at once ────────────────────────────────

    @Test
    fun `HAPPY Confirm immediately books the visit and sends the confirmation the admin chose`() = runTest(testDispatcher) {
        coEvery { bookingRepo.createBooking(any(), any()) } returns Result.success("b1")
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns Result.success(emptyList())
        coEvery {
            kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.success("vis_enh_b1")
        every { kinCareRepo.lastCreatedVisitNotice } returns told
        val vm = vm()
        vm.createBooking(booking(), notifyHousehold = true)
        coVerify(exactly = 1) {
            kinCareRepo.createKinCareSession(
                kinfolkId = "kf1",
                kinIds = any(),
                serviceType = any(),
                startTime = any(),
                endTime = any(),
                serviceDurationMinutes = any(),
                notes = any(),
                recordAsCompleted = any(),
                notifyHousehold = true,
                enhancedBookingId = "b1",
            )
        }
        assertEquals("The Wrens's visit is scheduled. Dre East was sent an email.", vm.state.value.bookingActionMessage)
    }

    @Test
    fun `NEGATIVE Confirm immediately forced past a conflict still books it with the chosen confirmation`() = runTest(testDispatcher) {
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings(enableConflictDetection = true))
        coEvery { bookingRepo.evaluateAvailability(any()) } returns Result.success(
            com.tribetails.auntieos.data.model.BookingAvailabilityResult(isAvailable = false, conflictingBookings = listOf(booking())),
        )
        coEvery { bookingRepo.createBooking(any(), any()) } returns Result.success("b1")
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("b1") } returns Result.success(emptyList())
        coEvery {
            kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.success("vis_enh_b1")
        every { kinCareRepo.lastCreatedVisitNotice } returns null
        val vm = vm()
        vm.createBooking(booking().copy(id = ""), notifyHousehold = false)
        assertEquals(true, vm.state.value.showConflictDialog)
        vm.resolveConflict(forceCreate = true)
        coVerify(exactly = 1) {
            kinCareRepo.createKinCareSession(
                kinfolkId = "kf1", kinIds = any(), serviceType = any(), startTime = any(), endTime = any(),
                serviceDurationMinutes = any(), notes = any(), recordAsCompleted = any(),
                notifyHousehold = false, enhancedBookingId = "b1",
            )
        }
    }
    @Test
    fun `SAD a draft books nothing and sends nothing`() = runTest(testDispatcher) {
        coEvery { bookingRepo.createBooking(any(), any()) } returns Result.success("b2")
        val vm = vm()
        vm.createBooking(booking().copy(id = "", status = BookingStatus.DRAFT), notifyHousehold = true)
        coVerify(exactly = 0) {
            kinCareRepo.createKinCareSession(any(), any(), any(), any(), any(), any(), any(), any(), any(), any())
        }
    }

    @Test
    fun `the New Booking line asks about the picked household's confirmation`() = runTest(testDispatcher) {
        val vm = vm()
        vm.loadNewVisitPreview("kf1")
        assertEquals(Triple("kf1", "kincare.booking.confirm", null), previewCalls.single())
        assertEquals("Dre East will get an email.", householdNoticeConfirmLine(vm.state.value.newVisitPreview, ""))
    }
}
