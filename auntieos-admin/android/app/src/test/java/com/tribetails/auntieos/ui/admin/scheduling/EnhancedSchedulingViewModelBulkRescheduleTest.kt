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

/**
 * #397 M16: bulk reschedule as a per-visit review sheet.
 *
 * THE ONE THING THESE TESTS EXIST TO PIN DOWN: each selected visit is moved to
 * ITS OWN window, not to one shared new time. Everything else here is the
 * honesty rules that go with a bulk surface: an ineligible booking is named
 * rather than dropped, an untouched row fires no write at all, a refusal is
 * reported per visit with the server's own sentence, and the override it offers
 * is offered exactly once.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelBulkRescheduleTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository

    /** Two confirmed bookings on the calendar, at different times of the same day. */
    private val wrens = EnhancedBooking(
        id = "bk_wrens",
        kinfolkId = "kf1",
        kinfolkName = "The Wrens",
        startDateTime = "2026-06-02T10:00:00",
        endDateTime = "2026-06-02T11:00:00",
        status = BookingStatus.ACCEPTED,
    )
    private val devlins = EnhancedBooking(
        id = "bk_devlins",
        kinfolkId = "kf2",
        kinfolkName = "The Devlins",
        startDateTime = "2026-06-02T15:00:00",
        endDateTime = "2026-06-02T16:30:00",
        status = BookingStatus.ACCEPTED,
    )
    private val draft = EnhancedBooking(
        id = "bk_draft",
        kinfolkId = "kf3",
        kinfolkName = "The Sparrows",
        startDateTime = "2026-06-03T09:00:00",
        endDateTime = "2026-06-03T10:00:00",
        status = BookingStatus.DRAFT,
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
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns
            Result.success(listOf(wrens, devlins, draft))
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
        coEvery { bookingRepo.updateBookingTimes(any(), any(), any()) } returns Result.success(Unit)

        // Each booking resolves to its own linked kin_care_sessions row: this
        // screen renders `enhanced_bookings` and the callable writes sessions.
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("bk_wrens") } returns
            Result.success(listOf(KinCareSession(id = "ses_wrens", kinfolkId = "kf1", status = "SCHEDULED")))
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("bk_devlins") } returns
            Result.success(listOf(KinCareSession(id = "ses_devlins", kinfolkId = "kf2", status = "SCHEDULED")))
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
    )

    private fun refusal(code: String, message: String) =
        Result.failure<Unit>(BookingRequestRefusedException(code, message))

    @Test
    fun `the sheet prefills every eligible visit and names the one it cannot move`() = runTest {
        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens", "bk_devlins", "bk_draft"))

        val state = vm.state.value
        assertEquals(listOf("bk_wrens", "bk_devlins"), state.bulkRescheduleTargets.map { it.bookingId })
        // Prefilled with the window each visit holds now, so an untouched row is
        // an unchanged row.
        assertEquals("2026-06-02", state.bulkRescheduleTargets[0].date)
        assertEquals("10:00", state.bulkRescheduleTargets[0].time)
        assertEquals("15:00", state.bulkRescheduleTargets[1].time)
        // The DRAFT is offered no field, and is not silently absent either: a
        // draft has no kin_care_sessions row, because approval is what creates one.
        assertEquals(1, state.bulkRescheduleSkipped.size)
        assertEquals("The Sparrows", state.bulkRescheduleSkipped[0].name)
        assertTrue(state.bulkRescheduleSkipped[0].message.contains("awaiting a reply"))
    }

    @Test
    fun `each visit moves to its own new window, and an untouched row is never written`() = runTest {
        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens", "bk_devlins"))
        vm.bulkRescheduleVisits(
            listOf(
                BulkRescheduleEntry("bk_wrens", "2026-06-03", "11:30"),
                // Left exactly where it was.
                BulkRescheduleEntry("bk_devlins", "2026-06-02", "15:00"),
            ),
        )

        // The Wrens move, and keep their own hour. The Devlins are not sent at
        // all: a write for a move nobody made would still fire an audit entry
        // and a household notification.
        coVerify(exactly = 1) {
            kinCareRepo.rescheduleBooking(
                sessionId = "ses_wrens",
                startTime = "2026-06-03T11:30:00",
                endTime = "2026-06-03T12:30:00",
                overrideBusyConflict = false,
                overrideVisitConflict = false,
            )
        }
        coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(sessionId = "ses_devlins", startTime = any(), endTime = any(), overrideBusyConflict = any(), overrideVisitConflict = any()) }

        val rows = vm.state.value.bulkRescheduleResults
        assertEquals(BulkRescheduleStatus.MOVED, rows.first { it.bookingId == "bk_wrens" }.status)
        val untouched = rows.first { it.bookingId == "bk_devlins" }
        assertEquals(BulkRescheduleStatus.SKIPPED, untouched.status)
        assertTrue(untouched.message.contains("unchanged"))
        assertEquals("Moved 1 of 2 selected visits.", bulkRescheduleSummary(rows))
    }

    @Test
    fun `both visits keep their own length, which one shared delta could never do`() = runTest {
        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens", "bk_devlins"))
        vm.bulkRescheduleVisits(
            listOf(
                BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00"),
                BulkRescheduleEntry("bk_devlins", "2026-06-05", "13:15"),
            ),
        )

        // An hour and an hour and a half, moved to two different days at two
        // different clocks, each preserving its own duration.
        coVerify(exactly = 1) {
            kinCareRepo.rescheduleBooking("ses_wrens", "2026-06-04T08:00:00", "2026-06-04T09:00:00", false, false)
        }
        coVerify(exactly = 1) {
            kinCareRepo.rescheduleBooking("ses_devlins", "2026-06-05T13:15:00", "2026-06-05T14:45:00", false, false)
        }
        assertEquals(
            listOf(BulkRescheduleStatus.MOVED, BulkRescheduleStatus.MOVED),
            vm.state.value.bulkRescheduleResults.map { it.status },
        )
    }

    @Test
    fun `a partial run names the visit that landed and the one that was refused`() = runTest {
        coEvery {
            kinCareRepo.rescheduleBooking("ses_devlins", any(), any(), any(), any())
        } returns refusal(VISIT_OVERLAP_CONFLICT_CODE, "A visit already runs from 13:15 to 14:45.")

        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens", "bk_devlins", "bk_draft"))
        vm.bulkRescheduleVisits(
            listOf(
                BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00"),
                BulkRescheduleEntry("bk_devlins", "2026-06-05", "13:15"),
            ),
        )

        val rows = vm.state.value.bulkRescheduleResults
        val moved = rows.first { it.bookingId == "bk_wrens" }
        val refused = rows.first { it.bookingId == "bk_devlins" }
        assertEquals(BulkRescheduleStatus.MOVED, moved.status)
        assertEquals(BulkRescheduleStatus.REFUSED, refused.status)
        // The server's own sentence, never a summary of it.
        assertEquals("A visit already runs from 13:15 to 14:45.", refused.message)
        assertEquals(ScheduleOverrideKind.VISIT, refused.override)
        // The ineligible selection rides along in the same result, so the
        // headline counts everything the operator picked.
        assertEquals("Moved 1 of 3 selected visits.", bulkRescheduleSummary(rows))
        assertTrue(rows.any { it.bookingId == "bk_draft" && it.status == BulkRescheduleStatus.SKIPPED })
    }

    @Test
    fun `the override is offered once, and a second refusal offers nothing`() = runTest {
        coEvery {
            kinCareRepo.rescheduleBooking("ses_wrens", any(), any(), any(), any())
        } returns refusal(BOOKING_BUSY_CONFLICT_CODE, "That window is imported as busy.")

        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens"))
        vm.bulkRescheduleVisits(listOf(BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00")))
        assertEquals(ScheduleOverrideKind.BUSY, vm.state.value.bulkRescheduleResults[0].override)

        vm.retryBulkRescheduleWithOverride("bk_wrens")

        // The retry re-sends the SAME window, with the flag the refusal offered.
        coVerify(exactly = 1) {
            kinCareRepo.rescheduleBooking("ses_wrens", "2026-06-04T08:00:00", "2026-06-04T09:00:00", true, false)
        }
        val row = vm.state.value.bulkRescheduleResults[0]
        assertEquals(BulkRescheduleStatus.REFUSED, row.status)
        // Refused again, having already overridden: the same losing move is
        // never offered a second time.
        assertNull(row.override)
    }

    @Test
    fun `an override retry that lands turns the row into a move`() = runTest {
        coEvery {
            kinCareRepo.rescheduleBooking("ses_wrens", any(), any(), false, false)
        } returns refusal(VISIT_OVERLAP_CONFLICT_CODE, "A visit already runs then.")
        coEvery {
            kinCareRepo.rescheduleBooking("ses_wrens", any(), any(), false, true)
        } returns Result.success(Unit)

        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens"))
        vm.bulkRescheduleVisits(listOf(BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00")))
        vm.retryBulkRescheduleWithOverride("bk_wrens")

        assertEquals(BulkRescheduleStatus.MOVED, vm.state.value.bulkRescheduleResults[0].status)
    }

    @Test
    fun `a company closure is refused with no override, ever`() = runTest {
        coEvery {
            kinCareRepo.rescheduleBooking("ses_wrens", any(), any(), any(), any())
        } returns refusal(COMPANY_HOLIDAY_CONFLICT_CODE, "The business is closed on 2026-06-04.")

        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens"))
        vm.bulkRescheduleVisits(listOf(BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00")))

        val row = vm.state.value.bulkRescheduleResults[0]
        assertEquals(BulkRescheduleStatus.REFUSED, row.status)
        assertEquals("The business is closed on 2026-06-04.", row.message)
        assertNull(row.override)
        // And a stray retry press sends nothing, because there is nothing to offer.
        vm.retryBulkRescheduleWithOverride("bk_wrens")
        coVerify(exactly = 1) { kinCareRepo.rescheduleBooking("ses_wrens", any(), any(), any(), any()) }
    }

    @Test
    fun `a booking with no linked visit is named, not counted as moved`() = runTest {
        coEvery { kinCareRepo.getKinCareSessionsBySourceBookingId("bk_wrens") } returns
            Result.success(emptyList())

        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens"))
        vm.bulkRescheduleVisits(listOf(BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00")))

        val row = vm.state.value.bulkRescheduleResults[0]
        assertEquals(BulkRescheduleStatus.SKIPPED, row.status)
        assertTrue(row.message.contains("nothing to move"))
        coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `an unreadable date is left alone and says so`() = runTest {
        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens"))
        vm.bulkRescheduleVisits(listOf(BulkRescheduleEntry("bk_wrens", "2026-02-30", "08:00")))

        val row = vm.state.value.bulkRescheduleResults[0]
        assertEquals(BulkRescheduleStatus.SKIPPED, row.status)
        assertTrue(row.message.contains("not a real date and time"))
        coVerify(exactly = 0) { kinCareRepo.rescheduleBooking(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a move whose calendar patch fails is still a move, and says the calendar is stale`() = runTest {
        coEvery { bookingRepo.updateBookingTimes("bk_wrens", any(), any()) } returns
            Result.failure(IllegalStateException("permission-denied"))

        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens"))
        vm.bulkRescheduleVisits(listOf(BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00")))

        val row = vm.state.value.bulkRescheduleResults[0]
        assertEquals(BulkRescheduleStatus.MOVED, row.status)
        assertTrue(row.message.contains("could not be updated to match"))
    }

    @Test
    fun `closing the sheet forgets it without undoing anything`() = runTest {
        val vm = buildViewModel()
        vm.openBulkReschedule(setOf("bk_wrens"))
        vm.bulkRescheduleVisits(listOf(BulkRescheduleEntry("bk_wrens", "2026-06-04", "08:00")))
        vm.closeBulkReschedule()

        val state = vm.state.value
        assertTrue(!state.bulkRescheduleOpen)
        assertTrue(state.bulkRescheduleResults.isEmpty())
        assertTrue(state.bulkRescheduleTargets.isEmpty())
        coVerify(exactly = 1) { kinCareRepo.rescheduleBooking("ses_wrens", any(), any(), any(), any()) }
    }
}

/** The eligibility and prefill helpers, at the layer that decides them. */
class BulkRescheduleHelpersTest {

    @Test
    fun `only a confirmed booking has a visit to move`() {
        assertTrue(bulkRescheduleApplies(BookingStatus.ACCEPTED))
        assertTrue(!bulkRescheduleApplies(BookingStatus.DRAFT))
        assertTrue(!bulkRescheduleApplies(BookingStatus.REJECTED))
        assertTrue(!bulkRescheduleApplies(BookingStatus.COMPLETED))
    }

    @Test
    fun `every ineligible status gets its own sentence`() {
        assertTrue(bulkRescheduleSkipReason(BookingStatus.DRAFT).contains("awaiting a reply"))
        assertTrue(bulkRescheduleSkipReason(BookingStatus.COMPLETED).contains("completed"))
        assertTrue(bulkRescheduleSkipReason(BookingStatus.REJECTED).contains("cancelled"))
    }

    @Test
    fun `a prefill is blank rather than a guess when the stored start does not parse`() {
        assertEquals("2026-06-02", rescheduleDatePrefill("2026-06-02T10:00:00"))
        assertEquals("10:00", rescheduleTimePrefill("2026-06-02T10:00:00"))
        assertEquals("", rescheduleDatePrefill("sometime Tuesday"))
        assertEquals("", rescheduleTimePrefill("sometime Tuesday"))
        assertEquals("", rescheduleTimePrefill("2026-06-02"))
    }

    @Test
    fun `the summary names both numbers, in the right number`() {
        val moved = BulkRescheduleRow("a", "The Wrens", BulkRescheduleStatus.MOVED, "Moved.")
        val refused = BulkRescheduleRow("b", "The Devlins", BulkRescheduleStatus.REFUSED, "No.")
        assertEquals("Moved 1 of 1 selected visit.", bulkRescheduleSummary(listOf(moved)))
        assertEquals("Moved 1 of 2 selected visits.", bulkRescheduleSummary(listOf(moved, refused)))
    }
}
