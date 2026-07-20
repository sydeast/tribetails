package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.TestData
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Additional [SettingsViewModel] tests that extend coverage beyond the 7 in SettingsViewModelTest.
 * Uses [TestData] for all fixture data.
 */
class SettingsViewModelExtTest {

    private fun buildViewModel(ds: FakeAuntieDataSource = FakeAuntieDataSource()) =
        SettingsViewModel(ds)

    // ---- state integrity after updates ----

    @Test
    fun `settingsResult updates when data source emits new data`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)

        // First emission
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))
        val firstState = vm.uiState.value
        assertIs<FirestoreResult.Data<BusinessSettings>>(firstState.settingsResult)
        assertEquals("TribeTails Pet Care", (firstState.settingsResult as FirestoreResult.Data<BusinessSettings>).value.businessName)

        // Second emission with updated data
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettingsUpdated))
        val secondState = vm.uiState.value
        assertIs<FirestoreResult.Data<BusinessSettings>>(secondState.settingsResult)
        assertEquals("TribeTails Premium Pet Care", (secondState.settingsResult as FirestoreResult.Data<BusinessSettings>).value.businessName)
    }

    @Test
    fun `settingsResult transitions from data to error`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)

        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))
        assertIs<FirestoreResult.Data<*>>(vm.uiState.value.settingsResult)

        ds.emitBusinessSettings(FirestoreResult.Error("connection lost"))
        assertIs<FirestoreResult.Error>(vm.uiState.value.settingsResult)
    }

    // ---- saveSuccess and saveError are independent ----

    @Test
    fun `saveSuccess is false in initial state`() = runTest {
        val vm = buildViewModel()
        assertFalse(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `saveError is null in initial state`() = runTest {
        val vm = buildViewModel()
        assertNull(vm.uiState.value.saveError)
    }

    @Test
    fun `save success does not set saveError`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))

        vm.saveSettings(TestData.businessSettings)

        assertNull(vm.uiState.value.saveError)
    }

    @Test
    fun `save failure does not set saveSuccess`() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "oops")
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))

        vm.saveSettings(TestData.businessSettings)

        assertFalse(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `save failure error message contains data source error text`() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "quota exceeded")
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))

        vm.saveSettings(TestData.businessSettings)

        assertNotNull(vm.uiState.value.saveError)
        assertTrue(vm.uiState.value.saveError!!.contains("quota exceeded"))
    }

    // ---- sequential saves ----

    @Test
    fun `consecutive successful saves keep saveSuccess true`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))

        vm.saveSettings(TestData.businessSettings)
        assertTrue(vm.uiState.value.saveSuccess)

        vm.clearSaveSuccess()
        assertFalse(vm.uiState.value.saveSuccess)

        vm.saveSettings(TestData.businessSettingsUpdated)
        assertTrue(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `save after clearSaveError produces fresh saveError on failure`() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "first error")
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))

        vm.saveSettings(TestData.businessSettings)
        assertNotNull(vm.uiState.value.saveError)

        vm.clearSaveError()
        assertNull(vm.uiState.value.saveError)

        // A second save with same failing ds produces a new error
        vm.saveSettings(TestData.businessSettingsUpdated)
        assertNotNull(vm.uiState.value.saveError)
    }

    // H6: saveSettings before data loads must fail visibly - not silently succeed

    @Test
    fun `saveSettings before data loads sets saveError not saveSuccess`() = runTest {
        val ds = FakeAuntieDataSource() // never emits settings - stays Loading
        val vm = buildViewModel(ds)

        vm.saveSettings(TestData.businessSettings)

        assertFalse(vm.uiState.value.saveSuccess, "saveSuccess must be false when settings not yet loaded")
        assertNotNull(vm.uiState.value.saveError, "saveError must be set when save is attempted before load")
    }

    // H8: state recovers from FirestoreResult.Error to Data after a new emission

    @Test
    fun `settingsResult recovers from error to data after new emission`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)

        ds.emitBusinessSettings(FirestoreResult.Error("transient failure"))
        assertIs<FirestoreResult.Error>(vm.uiState.value.settingsResult)

        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))
        assertIs<FirestoreResult.Data<BusinessSettings>>(
            vm.uiState.value.settingsResult,
            "State must recover to Data after a new Data emission following an Error"
        )
    }

    // ---- settingsResult field values ----

    @Test
    fun `loaded settings preserves all field values`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(TestData.businessSettings))

        val result = vm.uiState.value.settingsResult
        assertIs<FirestoreResult.Data<BusinessSettings>>(result)

        val settings = result.value
        assertEquals("TribeTails Pet Care", settings.businessName)
        assertEquals("hello@tribetails.example", settings.businessEmail)
        assertEquals("555-9000", settings.businessPhone)
        assertEquals("123 Main St, Atlanta, GA 30301", settings.businessAddress)
        assertEquals("25.00", settings.serviceRates["Dog Walking"])
        assertEquals("50.00", settings.serviceRates["Pet Sitting"])
    }
}
