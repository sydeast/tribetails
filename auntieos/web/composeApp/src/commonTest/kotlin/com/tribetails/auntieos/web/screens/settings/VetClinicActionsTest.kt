package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.VetClinic
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Integration tests for the Settings vet-clinic write actions (full CRUD).
 * Drives the real SettingsViewModel against a FakeAuntieDataSource, covering the
 * happy path (call reaches the data layer, no error) and the sad/error path
 * (failure surfaces on vetClinicError, never silently swallowed).
 */
class VetClinicActionsTest {

    private val clinic = VetClinic(_id = "c1", name = "Creekside", phone = "555", address = "1 Ln", notes = "n")

    @Test
    fun `stream surfaces clinics from the data source`() = runTest {
        val ds = FakeAuntieDataSource()
        ds.emitVetClinics(FirestoreResult.Data(listOf(clinic)))
        val vm = SettingsViewModel(ds)
        assertEquals(FirestoreResult.Data(listOf(clinic)), vm.vetClinicsStream().first())
    }

    @Test
    fun `add happy path reaches data source and clears error`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = SettingsViewModel(ds)
        vm.addVetClinic(clinic).join()
        assertEquals(listOf(clinic), ds.createdVetClinics)
        assertNull(vm.vetClinicError.value)
    }

    @Test
    fun `save happy path reaches data source`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = SettingsViewModel(ds)
        vm.saveVetClinic(clinic).join()
        assertEquals(listOf(clinic), ds.updatedVetClinics)
        assertNull(vm.vetClinicError.value)
    }

    @Test
    fun `remove happy path hard-deletes by id`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = SettingsViewModel(ds)
        vm.removeVetClinic("c1", "Creekside").join()
        assertEquals(listOf("c1"), ds.deletedVetClinicIds)
        assertNull(vm.vetClinicError.value)
    }

    @Test
    fun `delete failure surfaces a fail-loud error message`() = runTest {
        val ds = FakeAuntieDataSource().apply { vetClinicWriteShouldFail = true; vetClinicWriteFailMessage = "permission-denied" }
        val vm = SettingsViewModel(ds)
        vm.removeVetClinic("c1", "Creekside").join()
        assertEquals(listOf("c1"), ds.deletedVetClinicIds)
        val err = vm.vetClinicError.value
        assertTrue(err != null && err.contains("Creekside") && err.contains("permission-denied"), "got: $err")
    }

    @Test
    fun `add failure surfaces error then a later success clears it`() = runTest {
        val ds = FakeAuntieDataSource().apply { vetClinicWriteShouldFail = true }
        val vm = SettingsViewModel(ds)
        vm.addVetClinic(clinic).join()
        assertTrue(vm.vetClinicError.value != null)
        ds.vetClinicWriteShouldFail = false
        vm.addVetClinic(clinic).join()
        assertNull(vm.vetClinicError.value)
    }
}
