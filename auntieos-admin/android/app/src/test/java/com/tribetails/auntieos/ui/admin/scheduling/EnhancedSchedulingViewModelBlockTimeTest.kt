package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.BookingRequestRefusedException
import com.tribetails.auntieos.data.repository.COMPANY_HOLIDAY_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.IMPORTED_BUSY_SLOT_CODE
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
 * #574: "Save Block" and "Unblock", from the press to the callable.
 *
 * Both used to write `booking_time_slots` straight from the client, which
 * `firestore.rules` denies, so neither had ever worked in production. These
 * tests pin the replacement at the layer the screens actually call: what the
 * validation refuses before anything goes out, what reaches the repository, and
 * which refusals may be gone past.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelBlockTimeTest {

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
        coEvery {
            bookingRepo.createBlockedTimeSlot(any(), any(), any(), any(), any(), any(), any())
        } returns Result.success("slot-new")
        coEvery { bookingRepo.deleteBlockedTimeSlot(any()) } returns Result.success(Unit)
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

    // ── validation runs BEFORE anything goes out ─────────────────────────────

    /**
     * THE DEFECT: the screen's own `?: LocalDate.now()` turned this into a block
     * on TODAY. The operator asked for one day and got another, with nothing
     * said.
     */
    @Test
    fun `an unparseable date blocks nothing at all, and never today instead`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()

            vm.blockTimeSlot("next tuesday", "09:00", "12:00", "Vet", BlockMode.TIME_BLOCK)

            coVerify(exactly = 0) {
                bookingRepo.createBlockedTimeSlot(any(), any(), any(), any(), any(), any(), any())
            }
            assertTrue(vm.state.value.scheduleWriteError?.contains("next tuesday") == true)
            assertNull("nothing was sent, so there is nothing to override", vm.state.value.scheduleWriteOverride)
        }

    @Test
    fun `an end before the start blocks nothing`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()

            vm.blockTimeSlot("2026-08-24", "17:00", "09:00", "", BlockMode.TIME_BLOCK)

            coVerify(exactly = 0) {
                bookingRepo.createBlockedTimeSlot(any(), any(), any(), any(), any(), any(), any())
            }
            assertEquals("The end has to come after the start.", vm.state.value.scheduleWriteError)
        }

    // ── the happy path ───────────────────────────────────────────────────────

    @Test
    fun `a good window reaches the callable with both halves and no override`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()

            vm.blockTimeSlot("2026-08-24", "09:00", "12:00", "Vet", BlockMode.TIME_BLOCK)

            coVerify(exactly = 1) {
                bookingRepo.createBlockedTimeSlot(
                    "2026-08-24", "09:00", "12:00", "Vet",
                    // The epoch-ms twin is what arms the server's overlap check;
                    // its exact value depends on the device zone and is pinned by
                    // BlockTimeFormTest against a fixed one.
                    more(0L), more(0L), false,
                )
            }
            assertNull(vm.state.value.scheduleWriteError)
        }

    @Test
    fun `a blank reason still names the block rather than writing an empty one`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()

            vm.blockTimeSlot("2026-08-24", "09:00", "12:00", "   ", BlockMode.TIME_BLOCK)

            coVerify(exactly = 1) {
                bookingRepo.createBlockedTimeSlot(any(), any(), any(), "Blocked", any(), any(), any())
            }
        }

    // ── the refusals ─────────────────────────────────────────────────────────

    @Test
    fun `a visit-overlap refusal offers Block anyway, and the retry carries the flag`() =
        runTest(testDispatcher) {
            coEvery {
                bookingRepo.createBlockedTimeSlot(any(), any(), any(), any(), any(), any(), any())
            } returns Result.failure(
                BookingRequestRefusedException(VISIT_OVERLAP_CONFLICT_CODE, "That time is already taken."),
            )

            val vm = buildViewModel()
            vm.blockTimeSlot("2026-08-24", "15:30", "17:00", "Vet", BlockMode.TIME_BLOCK)

            assertEquals(ScheduleOverrideKind.VISIT, vm.state.value.scheduleWriteOverride)
            assertEquals("That time is already taken.", vm.state.value.scheduleWriteError)

            coEvery {
                bookingRepo.createBlockedTimeSlot(any(), any(), any(), any(), any(), any(), any())
            } returns Result.success("slot-new")
            vm.retryScheduleWriteWithOverride()

            coVerify(exactly = 1) {
                bookingRepo.createBlockedTimeSlot(
                    "2026-08-24", "15:30", "17:00", "Vet", any(), any(), true,
                )
            }
            assertNull(vm.state.value.scheduleWriteError)
        }

    /**
     * A closure is the operator's own statement that the business is shut, and
     * `guardCompanyHolidayConflict` has no override parameter at all — so no
     * button may be drawn beside it.
     */
    @Test
    fun `a company closure refusal draws no Block anyway`() =
        runTest(testDispatcher) {
            coEvery {
                bookingRepo.createBlockedTimeSlot(any(), any(), any(), any(), any(), any(), any())
            } returns Result.failure(
                BookingRequestRefusedException(
                    COMPANY_HOLIDAY_CONFLICT_CODE,
                    "This date is not available. The business is closed.",
                ),
            )

            val vm = buildViewModel()
            vm.blockTimeSlot("2026-12-25", "09:00", "12:00", "", BlockMode.TIME_BLOCK)

            assertEquals("This date is not available. The business is closed.", vm.state.value.scheduleWriteError)
            assertNull(vm.state.value.scheduleWriteOverride)
        }

    // ── unblock ──────────────────────────────────────────────────────────────

    @Test
    fun `unblocking goes through the callable`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()

            vm.unblockTimeSlot("slot-1")

            coVerify(exactly = 1) { bookingRepo.deleteBlockedTimeSlot("slot-1") }
            assertNull(vm.state.value.scheduleWriteError)
        }

    /**
     * The Google-mirror refusal has no override: the next sync writes the row
     * back, so the remedy is in Google Calendar and the message says so.
     */
    @Test
    fun `a Google mirror refusal is surfaced with no retry offered`() =
        runTest(testDispatcher) {
            coEvery { bookingRepo.deleteBlockedTimeSlot(any()) } returns Result.failure(
                BookingRequestRefusedException(
                    IMPORTED_BUSY_SLOT_CODE,
                    "That busy block is a mirror of an event on the connected Google Calendar.",
                ),
            )

            val vm = buildViewModel()
            vm.unblockTimeSlot("slot-imported")

            assertEquals(
                "That busy block is a mirror of an event on the connected Google Calendar.",
                vm.state.value.scheduleWriteError,
            )
            assertNull(vm.state.value.scheduleWriteOverride)
        }
}
