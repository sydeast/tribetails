package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.slot
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
 * Slice 9 integration test for the special-hours save path (spec 29 item 15.5).
 * The Settings screen appends a "date|hours" entry then saves via
 * AdminSettingsViewModel.updateBusinessSettings -> repository.saveBusinessSettings.
 * Asserts the appended entry reaches the repository on success, saveSuccess flips,
 * and a save failure surfaces a fail-loud error (never a silent green).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsSpecialHoursViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = AdminSettingsViewModel(repository = repo)

    @Test
    fun `appended special hours entry is saved and saveSuccess flips`() = runTest(testDispatcher) {
        val captured = slot<BusinessSettings>()
        coEvery { repo.saveBusinessSettings(capture(captured), any()) } returns Result.success(Unit)

        val base = BusinessSettings(specialHours = emptyList())
        val withSpecial = base.copy(specialHours = base.specialHours + "2026-07-03|08:00-12:00")

        val vm = vm()
        vm.updateBusinessSettings(withSpecial)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue(state.saveSuccess)
        assertNull(state.error)
        // The appended encoded entry actually reached the repository write.
        assertEquals(listOf("2026-07-03|08:00-12:00"), captured.captured.specialHours)
    }

    @Test
    fun `save failure surfaces a fail-loud error and clears saveSuccess`() = runTest(testDispatcher) {
        coEvery { repo.saveBusinessSettings(any(), any()) } returns Result.failure(RuntimeException("quota exceeded"))

        val withSpecial = BusinessSettings(specialHours = listOf("2026-07-03|08:00-12:00"))

        val vm = vm()
        vm.updateBusinessSettings(withSpecial)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.saveSuccess)
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("quota exceeded"))
    }

    @Test
    fun `save uses the admin updatedBy actor`() = runTest(testDispatcher) {
        val actor = slot<String>()
        coEvery { repo.saveBusinessSettings(any(), capture(actor)) } returns Result.success(Unit)

        val vm = vm()
        vm.updateBusinessSettings(BusinessSettings(specialHours = listOf("2026-07-03|08:00-12:00")))
        advanceUntilIdle()

        assertEquals("admin", actor.captured)
    }
}
