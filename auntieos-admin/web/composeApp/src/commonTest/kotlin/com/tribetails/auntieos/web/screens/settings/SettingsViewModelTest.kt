package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertNotNull
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SettingsViewModelTest {

    private fun buildViewModel(ds: FakeAuntieDataSource = FakeAuntieDataSource()): SettingsViewModel =
        SettingsViewModel(ds)

    @Test
    fun `initial state is loading`() = runTest {
        val vm = buildViewModel()
        assertIs<FirestoreResult.Loading>(vm.uiState.value.settingsResult)
    }

    @Test
    fun `load settings populates state when data emitted`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        val settings = BusinessSettings(businessName = "TribeTails", businessEmail = "hello@tribetails.com")
        ds.emitBusinessSettings(FirestoreResult.Data(settings))

        val state = vm.uiState.value
        assertIs<FirestoreResult.Data<BusinessSettings>>(state.settingsResult)
        assertEquals("TribeTails", (state.settingsResult as FirestoreResult.Data<BusinessSettings>).value.businessName)
    }

    @Test
    fun `load settings sets error state when data source emits error`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Error("network failure"))

        val state = vm.uiState.value
        assertIs<FirestoreResult.Error>(state.settingsResult)
        assertEquals("network failure", (state.settingsResult as FirestoreResult.Error).message)
    }

    @Test
    fun `save settings calls data source and sets saveSuccess true on success`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        val settings = BusinessSettings(businessName = "Saved", businessEmail = "saved@test.com")
        ds.emitBusinessSettings(FirestoreResult.Data(settings))

        vm.saveSettings(settings)

        assertTrue(vm.uiState.value.saveSuccess, "saveSuccess must be true after successful save")
        assertNull(vm.uiState.value.saveError, "saveError must be null after successful save")
    }

    @Test
    fun `save settings carries calendarSyncId through to the data source`() = runTest {
        // Editing the Google Calendar id in Settings persists onto BusinessSettings;
        // the sync callable later reads that same field. Assert the VM forwards it.
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        val loaded = BusinessSettings(_id = "singleton", businessName = "TribeTails")
        ds.emitBusinessSettings(FirestoreResult.Data(loaded))

        vm.saveSettings(loaded.copy(calendarSyncId = "auntie@group.calendar.google.com"))

        assertTrue(vm.uiState.value.saveSuccess, "saveSuccess must be true after successful save")
        assertEquals(
            "auntie@group.calendar.google.com",
            ds.lastSavedBusinessSettings?.calendarSyncId,
            "calendarSyncId must reach the data source unchanged",
        )
    }

    @Test
    fun `save settings sets saveError when data source fails`() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "Write denied")
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(BusinessSettings()))

        vm.saveSettings(BusinessSettings())

        assertFalse(vm.uiState.value.saveSuccess, "saveSuccess must be false after failed save")
        assertNotNull(vm.uiState.value.saveError, "saveError must be set after failed save")
        assertTrue(vm.uiState.value.saveError!!.contains("Write denied"), "saveError should contain error message")
    }

    @Test
    fun `clearSaveSuccess resets saveSuccess to false`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(BusinessSettings()))
        vm.saveSettings(BusinessSettings())
        assertTrue(vm.uiState.value.saveSuccess, "precondition: saveSuccess should be true")

        vm.clearSaveSuccess()

        assertFalse(vm.uiState.value.saveSuccess, "saveSuccess must be false after clearSaveSuccess")
    }

    @Test
    fun `clearSaveError resets saveError to null`() = runTest {
        val ds = FakeAuntieDataSource(saveShouldFail = true, saveFailMessage = "oops")
        val vm = buildViewModel(ds)
        ds.emitBusinessSettings(FirestoreResult.Data(BusinessSettings()))
        vm.saveSettings(BusinessSettings())
        assertNotNull(vm.uiState.value.saveError, "precondition: saveError should be set")

        vm.clearSaveError()

        assertNull(vm.uiState.value.saveError, "saveError must be null after clearSaveError")
    }
}
