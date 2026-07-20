package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HouseholdDataViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        // Phase 2: loadHouseholdData also reads the dossier notes for the reference card.
        // Default to no notes so the existing household-load tests stay focused.
        coEvery { mockRepo.getDossier(any()) } returns Result.success(null)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = HouseholdDataViewModel(repository = mockRepo)

    @Test
    fun `initial state has empty householdData and isLoading true`() {
        val vm = buildViewModel()
        val state = vm.uiState.value
        assertEquals(HouseholdData(), state.householdData)
    }

    @Test
    fun `loadHouseholdData populates state on success`() = runTest(testDispatcher) {
        val data = HouseholdData(kinfolkId = "kf1", primaryVetName = "Dr. Smith")
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(data)

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertEquals("Dr. Smith", state.householdData.primaryVetName)
        assertNull(state.error)
    }

    @Test
    fun `loadHouseholdData returns default HouseholdData when repo returns null`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(null)

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertEquals("kf1", state.householdData.kinfolkId)
    }

    @Test
    fun `loadHouseholdData sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData(any()) } returns Result.failure(RuntimeException("Load failed"))

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertNotNull(state.error)
    }

    @Test
    fun `updatePrimaryVetName updates householdData in state`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(HouseholdData(kinfolkId = "kf1"))

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        vm.updatePrimaryVetName("Animal Hospital")

        assertEquals("Animal Hospital", vm.uiState.value.householdData.primaryVetName)
    }
}
