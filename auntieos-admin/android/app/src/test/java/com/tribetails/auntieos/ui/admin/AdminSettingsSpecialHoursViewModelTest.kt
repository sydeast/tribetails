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
 * AdminSettingsViewModel.updateBusinessSettings ->
 * repository.updateBusinessSettingsFields.
 * Asserts the appended entry reaches the repository on success, saveSuccess flips,
 * and a save failure surfaces a fail-loud error (never a silent green).
 *
 * The write is a DIFF now, so the assertion is on the `specialHours` KEY of the
 * written map rather than on a whole settings object: a save that carried the
 * other ~45 fields would revert whatever the React admin changed in between.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsSpecialHoursViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    /** What the phone read. A save diffs against this, never against defaults. */
    private val stored = BusinessSettings(specialHours = emptyList())

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getBusinessSettings() } returns Result.success(stored)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = AdminSettingsViewModel(repository = repo).also { it.loadBusinessSettings() }

    @Test
    fun `appended special hours entry is saved and saveSuccess flips`() = runTest(testDispatcher) {
        val captured = slot<Map<String, Any?>>()
        coEvery { repo.updateBusinessSettingsFields(capture(captured), any()) } returns Result.success(Unit)

        val vm = vm()
        val base = vm.uiState.value.businessSettings
        vm.updateBusinessSettings(base.copy(specialHours = base.specialHours + "2026-07-03|08:00-12:00"))
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue(state.saveSuccess)
        assertNull(state.error)
        // The appended encoded entry actually reached the repository write, and
        // it is the ONLY thing that did.
        assertEquals(
            mapOf<String, Any?>("specialHours" to listOf("2026-07-03|08:00-12:00")),
            captured.captured,
        )
    }

    @Test
    fun `save failure surfaces a fail-loud error and clears saveSuccess`() = runTest(testDispatcher) {
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns
            Result.failure(RuntimeException("quota exceeded"))

        val vm = vm()
        vm.updateBusinessSettings(
            vm.uiState.value.businessSettings.copy(specialHours = listOf("2026-07-03|08:00-12:00"))
        )
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.saveSuccess)
        assertNotNull(state.error)
        assertTrue(state.error!!.contains("quota exceeded"))
    }

    @Test
    fun `save uses the admin updatedBy actor`() = runTest(testDispatcher) {
        val actor = slot<String>()
        coEvery { repo.updateBusinessSettingsFields(any(), capture(actor)) } returns Result.success(Unit)

        val vm = vm()
        vm.updateBusinessSettings(
            vm.uiState.value.businessSettings.copy(specialHours = listOf("2026-07-03|08:00-12:00"))
        )
        advanceUntilIdle()

        assertEquals("admin", actor.captured)
    }
}
