package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.CoveragePackageConfig
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.CoverageRules
import com.tribetails.auntieos.domain.DEFAULT_DURATIONS
import com.tribetails.auntieos.domain.Duration
import io.mockk.coEvery
import io.mockk.coVerify
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for [CoveragePackageViewModel]. Always pass a mock repository; the
 * default constructor touches AuntieOSApp.instance.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CoveragePackageViewModelTest {

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

    private fun buildViewModel() = CoveragePackageViewModel(repository = mockRepo)

    @Test
    fun `loadConfig populates state with returned config`() = runTest(testDispatcher) {
        val config = CoveragePackageConfig(durations = DEFAULT_DURATIONS, updatedBy = "auntie@x.com")
        coEvery { mockRepo.getCoveragePackageConfig() } returns Result.success(config)

        val vm = buildViewModel()
        vm.loadConfig()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertNull(state.error)
        assertEquals(DEFAULT_DURATIONS, state.config.durations)
        assertEquals("auntie@x.com", state.config.updatedBy)
    }

    @Test
    fun `loadConfig sets error state when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.getCoveragePackageConfig() } returns Result.failure(RuntimeException("permission-denied"))

        val vm = buildViewModel()
        vm.loadConfig()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("permission-denied"))
    }

    @Test
    fun `saveConfig writes the edited menu plus rules and sets saveSuccess`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveCoveragePackageConfig(any(), any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        val durations = listOf(Duration("d1", "15-min", 15.0, 15.0))
        val rules = CoverageRules(maxGapHours = 5.0)
        vm.saveConfig(durations, rules)
        advanceUntilIdle()

        coVerify(exactly = 1) {
            mockRepo.saveCoveragePackageConfig(
                match { it.durations == durations && it.rules == rules },
                any(),
            )
        }
        val state = vm.uiState.value
        assertTrue(state.saveSuccess)
        assertNull(state.error)
        assertEquals(durations, state.config.durations)
        assertEquals(rules, state.config.rules)
    }

    @Test
    fun `saveConfig sets error and clears saveSuccess when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveCoveragePackageConfig(any(), any()) } returns Result.failure(RuntimeException("Write denied"))

        val vm = buildViewModel()
        vm.saveConfig(DEFAULT_DURATIONS, CoverageRules())
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.saveSuccess)
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("Write denied"))
    }

    @Test
    fun `clearError and clearSaveSuccess reset their flags`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveCoveragePackageConfig(any(), any()) } returns Result.success(Unit)
        val vm = buildViewModel()
        vm.saveConfig(DEFAULT_DURATIONS, CoverageRules())
        advanceUntilIdle()
        assertTrue(vm.uiState.value.saveSuccess)

        vm.clearSaveSuccess()
        assertFalse(vm.uiState.value.saveSuccess)

        coEvery { mockRepo.getCoveragePackageConfig() } returns Result.failure(RuntimeException("oops"))
        vm.loadConfig()
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.error)
        vm.clearError()
        assertNull(vm.uiState.value.error)
    }
}
