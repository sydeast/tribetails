package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BOOKING_BUSY_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.BookingRequestRefusedException
import com.tribetails.auntieos.data.repository.COMPANY_HOLIDAY_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ScheduleOverrideKind
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.data.repository.VISIT_OVERLAP_CONFLICT_CODE
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
import java.time.LocalDateTime

/**
 * #575: the three reschedule defects, at the layer that decides all three.
 *
 *  1. THE WRONG COLLECTION'S ID. This screen renders `enhanced_bookings`;
 *     `rescheduleBooking` writes `kin_care_sessions`. Android sent the booking's
 *     own id as `sessionId`, so the callable answered `not-found` and no
 *     reschedule from the phone ever landed.
 *  2. THE ENVELOPE NEVER FOLLOWED. Even a successful session move left this
 *     screen drawing the old slot, because the envelope carries its own copy of
 *     the times and nothing patched it.
 *  3. NO WAY PAST A REFUSAL. PR #571 added the server's visit-overlap guard, so
 *     a move onto an occupied slot is now correctly refused — and android had no
 *     "Move anyway" where web had one.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelRescheduleTest {

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
        coEvery { bookingRepo.updateBookingTimes(any(), any(), any()) } returns Result.success(Unit)
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
        id = ENVELOPE_ID,
        kinfolkId = "kf1",
        kinfolkName = "The Mendozas",
        startDateTime = "2026-06-02T10:00:00",
        endDateTime = "2026-06-02T11:00:00",
        status = BookingStatus.ACCEPTED,
    )

    private fun linked(vararg ids: String) {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId(ENVELOPE_ID) } returns
            Result.success(ids.map { KinCareSession(id = it, kinfolkId = "kf1", status = "SCHEDULED") })
    }

    private fun rescheduleSucceeds() {
        coEvery { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) } returns Result.success(Unit)
    }

    private fun rescheduleRefuses(code: String, message: String) {
        coEvery { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) } returns
            Result.failure(BookingRequestRefusedException(code, message))
    }

    // ── 1: the id ────────────────────────────────────────────────────────────

    /** THE DEFECT: `booking.id` went out as `sessionId`. It is a different collection. */
    @Test
    fun `a reschedule sends the linked session id, never the enhanced_bookings id`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleSucceeds()

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            coVerify(exactly = 1) {
                kinCareRepo.rescheduleBooking(
                    SESSION_ID,
                    "2026-06-03T14:00:00",
                    // The visit's own hour is preserved, never silently resized.
                    "2026-06-03T15:00:00",
                    false,
                    false,
                )
            }
            coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(ENVELOPE_ID, any(), any(), any(), any()) }
        }

    @Test
    fun `a booking with no linked visit is refused by name rather than sent anyway`() =
        runTest(testDispatcher) {
            linked()
            rescheduleSucceeds()

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
            val message = vm.state.value.scheduleWriteError
            assertTrue("expected a named refusal, got $message", message?.contains("No scheduled visit") == true)
            assertNull("a refusal nothing can retry offers no override", vm.state.value.scheduleWriteOverride)
        }

    @Test
    fun `a booking with two linked visits is refused rather than fanned onto both`() =
        runTest(testDispatcher) {
            linked(SESSION_ID, "s2")
            rescheduleSucceeds()

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
            assertTrue(vm.state.value.scheduleWriteError?.contains("2 visits") == true)
        }

    // ── 2: the envelope ──────────────────────────────────────────────────────

    /**
     * The server cannot mirror the move back: the envelope stores zoneless local
     * wall clock and the session stores instants. So the client patches it — as
     * a THREE-FIELD update, never as the whole-model `updateBooking` set that
     * rebuilds the document from screen state.
     */
    @Test
    fun `a successful move patches the envelope's window, and does not rebuild the document`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleSucceeds()

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            coVerify(exactly = 1) {
                bookingRepo.updateBookingTimes(ENVELOPE_ID, "2026-06-03T14:00:00", "2026-06-03T15:00:00")
            }
            coVerify(exactly = 0) { bookingRepo.updateBooking(any()) }
            assertNull(vm.state.value.scheduleWriteError)
        }

    @Test
    fun `a move the envelope patch could not follow says so instead of looking clean`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleSucceeds()
            coEvery { bookingRepo.updateBookingTimes(any(), any(), any()) } returns
                Result.failure(IllegalStateException("PERMISSION_DENIED"))

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            assertTrue(
                vm.state.value.scheduleWriteError?.contains("could not be updated to match") == true,
            )
        }

    // ── 3: the override ──────────────────────────────────────────────────────

    @Test
    fun `a visit-overlap refusal offers Move anyway, and the retry carries the flag`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleRefuses(
                VISIT_OVERLAP_CONFLICT_CODE,
                "That time is already taken: 2:00 PM to 3:00 PM overlaps a visit already booked.",
            )

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            assertEquals(ScheduleOverrideKind.VISIT, vm.state.value.scheduleWriteOverride)
            assertEquals(
                "the operator reads the server's own sentence",
                "That time is already taken: 2:00 PM to 3:00 PM overlaps a visit already booked.",
                vm.state.value.scheduleWriteError,
            )

            rescheduleSucceeds()
            vm.retryScheduleWriteWithOverride()

            coVerify(exactly = 1) {
                kinCareRepo.rescheduleBooking(SESSION_ID, any(), any(), false, true)
            }
        }

    @Test
    fun `a busy-import refusal offers Move anyway on the busy flag`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleRefuses(BOOKING_BUSY_CONFLICT_CODE, "This time is not available: a busy block covers it.")

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            assertEquals(ScheduleOverrideKind.BUSY, vm.state.value.scheduleWriteOverride)

            rescheduleSucceeds()
            vm.retryScheduleWriteWithOverride()

            coVerify(exactly = 1) {
                kinCareRepo.rescheduleBooking(SESSION_ID, any(), any(), true, false)
            }
        }

    /**
     * The asymmetry the whole `details.code` convention exists for: a closure has
     * no override parameter on the server at all, so no button may be drawn.
     */
    @Test
    fun `a company closure refusal draws no override at all`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleRefuses(COMPANY_HOLIDAY_CONFLICT_CODE, "This date is not available. The business is closed.")

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")

            assertEquals("This date is not available. The business is closed.", vm.state.value.scheduleWriteError)
            assertNull(vm.state.value.scheduleWriteOverride)

            // And a stray press sends nothing.
            vm.retryScheduleWriteWithOverride()
            coVerify(exactly = 1) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
        }

    @Test
    fun `the same losing move is never offered twice`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleRefuses(VISIT_OVERLAP_CONFLICT_CODE, "That time is already taken.")

            val vm = buildViewModel()
            vm.selectBooking(booking())
            vm.rescheduleSelectedBooking("2026-06-03", "14:00")
            assertEquals(ScheduleOverrideKind.VISIT, vm.state.value.scheduleWriteOverride)

            vm.retryScheduleWriteWithOverride()

            assertNull(
                "an override that was already taken and still refused is not re-offered",
                vm.state.value.scheduleWriteOverride,
            )
        }

    // ── the drag ─────────────────────────────────────────────────────────────

    /**
     * `completeDrag` used to build a whole [EnhancedBooking] and hand it to
     * `updateBooking`, a client set on `enhanced_bookings`: the visit itself
     * never moved and none of the server's guards ran.
     */
    @Test
    fun `a dropped drag reschedules through the callable, not a client write`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleSucceeds()

            val vm = buildViewModel()
            vm.startDragBooking(booking(), LocalDateTime.parse("2026-06-02T10:00:00"))
            vm.updateDragPosition(LocalDateTime.parse("2026-06-02T13:30:00"))
            vm.completeDrag()

            coVerify(exactly = 1) {
                kinCareRepo.rescheduleBooking(
                    SESSION_ID, "2026-06-02T13:30:00", "2026-06-02T14:30:00", false, false,
                )
            }
            coVerify(exactly = 1) {
                bookingRepo.updateBookingTimes(ENVELOPE_ID, "2026-06-02T13:30:00", "2026-06-02T14:30:00")
            }
            coVerify(exactly = 0) { bookingRepo.updateBooking(any()) }
            assertNull("the drag state is released once the drop is decided", vm.state.value.dragState)
        }

    @Test
    fun `a drop back where the visit already was writes nothing at all`() =
        runTest(testDispatcher) {
            linked(SESSION_ID)
            rescheduleSucceeds()

            val vm = buildViewModel()
            vm.startDragBooking(booking(), LocalDateTime.parse("2026-06-02T10:00:00"))
            vm.completeDrag()

            coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
            coVerify(exactly = 0) { bookingRepo.updateBookingTimes(any(), any(), any()) }
            assertNull(vm.state.value.dragState)
        }

    private companion object {
        /** An `enhanced_bookings` document id — what android used to send as `sessionId`. */
        const val ENVELOPE_ID = "b1"

        /** The `kin_care_sessions` document id the callable actually addresses. */
        const val SESSION_ID = "s1"
    }
}
