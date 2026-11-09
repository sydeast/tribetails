package com.tribetails.auntieos.ui.admin

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.every
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * #1593: a save `saveBusinessSettings` refuses shows the server's sentence as it
 * stands, stays on screen as [AdminSettingsUiState.settingsRefusal] until the
 * next save, and puts the refused field back to what is saved.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsRefusalTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private val stored = BusinessSettings(businessName = "Tribe Tails", serviceRates = mapOf("Walk" to "10"))
    private val sentence = "Enter the price for \"Walk\" in dollars, like 25 or 25.50."

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

    private fun refusal(): FirebaseFunctionsException {
        val e = mockk<FirebaseFunctionsException>()
        every { e.message } returns sentence
        every { e.details } returns mapOf(
            "code" to "settings_refused",
            "field" to "serviceRates",
            "refusals" to listOf(mapOf("field" to "serviceRates", "message" to sentence)),
        )
        return e
    }

    @Test
    fun `a refusal is the server's sentence, kept until the next save`() = runTest(testDispatcher) {
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(refusal())
        val vm = AdminSettingsViewModel(repository = repo).also { it.loadBusinessSettings() }

        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(serviceRates = mapOf("Walk" to "abc")))
        advanceUntilIdle()

        assertEquals(sentence, vm.uiState.value.error)
        assertEquals(SettingsRefusal("serviceRates", sentence), vm.uiState.value.settingsRefusal)
        assertEquals(mapOf("Walk" to "10"), vm.uiState.value.businessSettings.serviceRates)

        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(serviceRates = mapOf("Walk" to "25")))
        advanceUntilIdle()

        assertNull(vm.uiState.value.settingsRefusal)
        assertEquals(mapOf("Walk" to "25"), vm.uiState.value.businessSettings.serviceRates)
    }

    @Test
    fun `any other failure keeps the lead-in and sets no refusal`() = runTest(testDispatcher) {
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns
            Result.failure(IllegalStateException("The server could not be reached."))
        val vm = AdminSettingsViewModel(repository = repo).also { it.loadBusinessSettings() }

        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(venmoHandle = "tribe-tails"))
        advanceUntilIdle()

        assertEquals("Failed to save settings: The server could not be reached.", vm.uiState.value.error)
        assertNull(vm.uiState.value.settingsRefusal)
    }
}
