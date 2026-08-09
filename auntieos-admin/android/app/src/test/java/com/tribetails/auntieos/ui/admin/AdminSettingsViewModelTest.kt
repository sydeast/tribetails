package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * Unit tests for AdminSettingsViewModel.
 *
 * The default constructor references AuntieOSApp.instance - always pass a mock
 * AuntieRepository explicitly; never call AdminSettingsViewModel() with no args from JVM tests.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsViewModelTest {

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

    /**
     * A save diffs against the copy the screen LOADED, so every save case below
     * loads first. A ViewModel that never loaded refuses to save at all rather
     * than writing ~46 Kotlin defaults over the document; `BusinessSettingsSaveTest`
     * covers that refusal, and the concurrent-edit cases, on its own.
     */
    private fun loadedViewModel(stored: BusinessSettings = BusinessSettings()): AdminSettingsViewModel {
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(stored)
        return buildViewModel().also { it.loadBusinessSettings() }
    }

    // ─── loadBusinessSettings ─────────────────────────────────────────────────

    @Test
    fun `loadBusinessSettings populates state with returned settings`() = runTest(testDispatcher) {
        val settings = BusinessSettings(
            enableGPSTrackingForAllVisits = false,
            defaultEtaMinutes = 20
        )
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(settings)

        val vm = buildViewModel()
        vm.loadBusinessSettings()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse("isLoading must be false after load", state.isLoading)
        assertNull("error must be null on success", state.error)
        assertFalse(state.businessSettings.enableGPSTrackingForAllVisits)
        assertEquals(20, state.businessSettings.defaultEtaMinutes)
    }

    @Test
    fun `loadBusinessSettings sets error state when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBusinessSettings() } returns Result.failure(RuntimeException("Network error"))

        val vm = buildViewModel()
        vm.loadBusinessSettings()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse("isLoading must be false after failure", state.isLoading)
        assertNotNull("error must be set on failure", state.error)
        assertTrue(state.error!!.contains("Network error"))
    }

    // ─── updateBusinessSettings ───────────────────────────────────────────────

    @Test
    fun `updateBusinessSettings sets saveSuccess true on success`() = runTest(testDispatcher) {
        coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)

        val vm = loadedViewModel()
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(defaultEtaMinutes = 30))
        advanceUntilIdle()

        // The DIFF reaches the repository, not the model: naming a field the
        // operator did not touch is what reverted concurrent web edits.
        coVerify(exactly = 1) {
            mockRepo.updateBusinessSettingsFields(mapOf<String, Any?>("defaultEtaMinutes" to 30), "admin")
        }
        val state = vm.uiState.value
        assertTrue("saveSuccess must be true on success", state.saveSuccess)
        assertNull("error must be null on success", state.error)
    }

    @Test
    fun `updateBusinessSettings sets error and clears saveSuccess when repository fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns
            Result.failure(RuntimeException("Write denied"))

        val vm = loadedViewModel()
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(defaultEtaMinutes = 30))
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse("saveSuccess must be false on failure", state.saveSuccess)
        assertNotNull("error must be set on failure", state.error)
        assertTrue(state.error!!.contains("Write denied"))
    }

    // ─── clearSaveSuccess / clearError ───────────────────────────────────────

    @Test
    fun `clearSaveSuccess resets saveSuccess to false`() = runTest(testDispatcher) {
        coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
        val vm = loadedViewModel()
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(defaultEtaMinutes = 30))
        advanceUntilIdle()
        assertTrue("precondition: saveSuccess should be true", vm.uiState.value.saveSuccess)

        vm.clearSaveSuccess()

        assertFalse("saveSuccess must be false after clearSaveSuccess", vm.uiState.value.saveSuccess)
    }

    @Test
    fun `two rapid updateBusinessSettings calls both complete without state corruption`() =
        runTest(testDispatcher) {
            coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)

            val vm = loadedViewModel()
            val settings = vm.uiState.value.businessSettings.copy(defaultEtaMinutes = 10)
            vm.updateBusinessSettings(settings)
            vm.updateBusinessSettings(settings.copy(defaultEtaMinutes = 20))
            advanceUntilIdle()

            assertTrue("Final state should have saveSuccess=true", vm.uiState.value.saveSuccess)
            assertNull(vm.uiState.value.error)
        }

    @Test
    fun `clearError resets error to null`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBusinessSettings() } returns Result.failure(RuntimeException("oops"))
        val vm = buildViewModel()
        vm.loadBusinessSettings()
        advanceUntilIdle()
        assertNotNull("precondition: error should be set", vm.uiState.value.error)

        vm.clearError()

        assertNull("error must be null after clearError", vm.uiState.value.error)
    }
}
