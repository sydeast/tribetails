package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessHours
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsViewModelBusinessHoursTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = AdminSettingsViewModel(repository = mockRepo)

    @Test
    fun `loadBusinessHours populates state pads to 7 days`() = runTest(testDispatcher) {
        val partial = listOf(
            BusinessHours(dayOfWeek = 1, isOpen = true, openTime = "10:00", closeTime = "18:00"),
            BusinessHours(dayOfWeek = 2, isOpen = true, openTime = "10:00", closeTime = "18:00"),
        )
        coEvery { mockRepo.getBusinessHours() } returns Result.success(partial)

        val vm = buildViewModel()
        vm.loadBusinessHours()
        advanceUntilIdle()

        val rows = vm.uiState.value.businessHours
        assertEquals(7, rows.size)
        assertEquals(listOf(1, 2, 3, 4, 5, 6, 7), rows.map { it.dayOfWeek })
        assertEquals("10:00", rows.first { it.dayOfWeek == 1 }.openTime)
        assertFalse("Sunday default should be closed", rows.first { it.dayOfWeek == 7 }.isOpen)
    }

    @Test
    fun `loadBusinessHours sets error when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBusinessHours() } returns Result.failure(RuntimeException("net"))

        val vm = buildViewModel()
        vm.loadBusinessHours()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertTrue(vm.uiState.value.error!!.contains("net"))
    }

    @Test
    fun `updateBusinessHours forwards list to repo and flips saveSuccess`() = runTest(testDispatcher) {
        val hours = (1..7).map { dow ->
            BusinessHours(dayOfWeek = dow, isOpen = true, openTime = "08:00", closeTime = "16:00")
        }
        coEvery { mockRepo.saveBusinessHours(any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        vm.updateBusinessHours(hours)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.saveBusinessHours(hours) }
        assertTrue(vm.uiState.value.saveSuccess)
        assertEquals(hours, vm.uiState.value.businessHours)
    }

    @Test
    fun `updateBusinessHours surfaces repo failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveBusinessHours(any()) } returns Result.failure(RuntimeException("denied"))

        val vm = buildViewModel()
        vm.updateBusinessHours(emptyList())
        advanceUntilIdle()

        assertFalse(vm.uiState.value.saveSuccess)
        assertNotNull(vm.uiState.value.error)
        assertTrue(vm.uiState.value.error!!.contains("denied"))
    }

    @Test
    fun `setBusinessHourRow replaces a single day in current state without persisting`() =
        runTest(testDispatcher) {
            val initial = (1..7).map { dow ->
                BusinessHours(dayOfWeek = dow, isOpen = true, openTime = "09:00", closeTime = "17:00")
            }
            coEvery { mockRepo.getBusinessHours() } returns Result.success(initial)
            val vm = buildViewModel()
            vm.loadBusinessHours()
            advanceUntilIdle()

            val updatedMon = initial[0].copy(openTime = "10:30")
            vm.setBusinessHourRow(updatedMon)

            val rows = vm.uiState.value.businessHours
            assertEquals(7, rows.size)
            assertEquals("10:30", rows.first { it.dayOfWeek == 1 }.openTime)
            // No save call made
            coVerify(exactly = 0) { mockRepo.saveBusinessHours(any()) }
        }
}
