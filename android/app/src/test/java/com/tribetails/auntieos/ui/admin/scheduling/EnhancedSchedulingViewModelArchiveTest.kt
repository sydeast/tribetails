package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.EnhancedBooking
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Phase 3 Tier 3 tests - reversible booking archive (mirrors Kinfolk Phase 2)
 * and force-update branch in resolveConflict (audit-discovered bug fix).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelArchiveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        bookingRepo = mockk()
        serviceRepo = mockk()
        auntieRepo  = mockk()
        coEvery { serviceRepo.getBaseServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { auntieRepo.saveBusinessSettings(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        // Live busy-slots stream consumed in init { observeBusyTimeSlots() }.
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = EnhancedSchedulingViewModel(
        bookingRepository = bookingRepo,
        serviceRepository = serviceRepo,
        auntieRepository  = auntieRepo,
    )

    @Test
    fun `archiveBooking routes to bookingRepository archiveBooking with reason`() =
        runTest(testDispatcher) {
            coEvery { bookingRepo.archiveBooking(any(), any(), any()) } returns Result.success(Unit)
            val vm = buildViewModel()
            advanceUntilIdle()

            vm.archiveBooking("b1", "no longer needed")
            advanceUntilIdle()

            coVerify(exactly = 1) { bookingRepo.archiveBooking("b1", "no longer needed", any()) }
            coVerify(exactly = 0) { bookingRepo.deleteBooking(any()) }
            coVerify(exactly = 1) {
                auntieRepo.logActivity(match<ActivityLogEntry> {
                    it.actionType == "ARCHIVE_BOOKING" && it.targetId == "b1"
                })
            }
        }

    @Test
    fun `archiveBooking surfaces repo failure`() = runTest(testDispatcher) {
        coEvery { bookingRepo.archiveBooking(any(), any(), any()) } returns
            Result.failure(RuntimeException("denied"))
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.archiveBooking("b1", "x")
        advanceUntilIdle()

        assertNotNull(vm.state.value.errorMessage)
        assertTrue(vm.state.value.errorMessage!!.contains("denied"))
    }

    @Test
    fun `unarchiveBooking routes to bookingRepository unarchiveBooking and fires audit`() =
        runTest(testDispatcher) {
            coEvery { bookingRepo.unarchiveBooking(any()) } returns Result.success(Unit)
            val vm = buildViewModel()
            advanceUntilIdle()

            vm.unarchiveBooking("b9")
            advanceUntilIdle()

            coVerify(exactly = 1) { bookingRepo.unarchiveBooking("b9") }
            coVerify(exactly = 1) {
                auntieRepo.logActivity(match<ActivityLogEntry> {
                    it.actionType == "UNARCHIVE_BOOKING" && it.targetId == "b9"
                })
            }
        }

    @Test
    fun `resolveConflict forceCreate=true with existing booking id routes to UPDATE not CREATE`() =
        runTest(testDispatcher) {
            // Selected booking has non-blank id → must take update path.
            val booking = EnhancedBooking(
                id = "b-existing",
                kinfolkName = "Pat",
                status = BookingStatus.ACCEPTED,
                startDateTime = "2026-05-20T09:00:00",
                endDateTime = "2026-05-20T10:00:00",
            )
            coEvery { bookingRepo.updateBooking(any()) } returns Result.success(Unit)
            coEvery { bookingRepo.evaluateAvailability(any()) } returns Result.failure(RuntimeException("not called here"))
            val vm = buildViewModel()
            advanceUntilIdle()

            vm.selectBooking(booking)
            vm.resolveConflict(forceCreate = true)
            advanceUntilIdle()

            coVerify(exactly = 1) { bookingRepo.updateBooking(any()) }
            coVerify(exactly = 0) { bookingRepo.createBooking(any()) }
            coVerify {
                auntieRepo.logActivity(match<ActivityLogEntry> {
                    it.actionType == "FORCE_UPDATE_BOOKING"
                })
            }
        }

    @Test
    fun `resolveConflict forceCreate=true with blank booking id still creates`() =
        runTest(testDispatcher) {
            val booking = EnhancedBooking(id = "", kinfolkName = "New")
            coEvery { bookingRepo.createBooking(any()) } returns Result.success("new-id")
            val vm = buildViewModel()
            advanceUntilIdle()

            vm.selectBooking(booking)
            vm.resolveConflict(forceCreate = true)
            advanceUntilIdle()

            coVerify(exactly = 1) { bookingRepo.createBooking(any()) }
            coVerify(exactly = 0) { bookingRepo.updateBooking(any()) }
            coVerify {
                auntieRepo.logActivity(match<ActivityLogEntry> {
                    it.actionType == "FORCE_CREATE_BOOKING"
                })
            }
        }

    @Test
    fun `resolveConflict forceCreate=false dismisses dialog without persisting`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()
            advanceUntilIdle()
            vm.selectBooking(EnhancedBooking(id = "b1"))

            vm.resolveConflict(forceCreate = false)
            advanceUntilIdle()

            assertFalse(vm.state.value.showConflictDialog)
            coVerify(exactly = 0) { bookingRepo.createBooking(any()) }
            coVerify(exactly = 0) { bookingRepo.updateBooking(any()) }
        }
}
