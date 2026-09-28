package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.VetClinic
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
        val edited = clinic.copy(phone = "556")
        vm.saveVetClinic(clinic, edited).join()
        assertEquals(listOf(edited), ds.updatedVetClinics)
        assertEquals(listOf(clinic), ds.updatedVetClinicBaselines, "#994: the loaded clinic is the diff baseline")
        assertNull(vm.vetClinicError.value)
    }

    @Test
    fun `approve diffs against the pending clinic it was shown`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = SettingsViewModel(ds)
        val pending = clinic.copy(verified = false, submittedBy = "uid-1")
        vm.approveVetClinic(pending).join()
        assertEquals(listOf(pending), ds.updatedVetClinicBaselines)
        assertEquals(listOf(pending.copy(verified = true, submittedBy = "")), ds.updatedVetClinics)
    }

    @Test
    fun `retire happy path archives by id`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = SettingsViewModel(ds)
        vm.retireVetClinic("c1", "Creekside").join()
        assertEquals(listOf("c1" to true), ds.archivedVetClinicCalls)
        assertNull(vm.vetClinicError.value)
    }

    @Test
    fun `restore happy path unarchives by id`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = SettingsViewModel(ds)
        vm.restoreVetClinic("c1", "Creekside").join()
        assertEquals(listOf("c1" to false), ds.archivedVetClinicCalls)
        assertNull(vm.vetClinicError.value)
    }

    @Test
    fun `reject archives a pending submission rather than deleting it`() = runTest {
        val ds = FakeAuntieDataSource()
        val vm = SettingsViewModel(ds)
        vm.rejectVetClinic("p1", "New Place").join()
        assertEquals(listOf("p1" to true), ds.archivedVetClinicCalls)
        assertNull(vm.vetClinicError.value)
    }

    @Test
    fun `retire failure surfaces a fail-loud error message`() = runTest {
        val ds = FakeAuntieDataSource().apply { vetClinicWriteShouldFail = true; vetClinicWriteFailMessage = "permission-denied" }
        val vm = SettingsViewModel(ds)
        vm.retireVetClinic("c1", "Creekside").join()
        assertEquals(listOf("c1" to true), ds.archivedVetClinicCalls)
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

    // ── #998: busy state, so a card's button can show a wait rather than looking clickable ──

    @Test
    fun `add is busy only while the create is in flight`() = runTest {
        val ds = FakeAuntieDataSource().apply { vetClinicGate = CompletableDeferred() }
        val vm = SettingsViewModel(ds)
        assertFalse(SettingsViewModel.ADD_VET_CLINIC_BUSY_ID in vm.vetClinicBusyIds.value)
        val job = vm.addVetClinic(clinic)
        assertTrue(SettingsViewModel.ADD_VET_CLINIC_BUSY_ID in vm.vetClinicBusyIds.value)
        ds.vetClinicGate?.complete(Unit)
        job.join()
        assertFalse(SettingsViewModel.ADD_VET_CLINIC_BUSY_ID in vm.vetClinicBusyIds.value)
    }

    @Test
    fun `retire is busy by clinic id only while in flight, and clears on failure too`() = runTest {
        val ds = FakeAuntieDataSource().apply {
            vetClinicGate = CompletableDeferred()
            vetClinicWriteShouldFail = true
        }
        val vm = SettingsViewModel(ds)
        val job = vm.retireVetClinic("c1", "Creekside")
        assertTrue("c1" in vm.vetClinicBusyIds.value)
        ds.vetClinicGate?.complete(Unit)
        job.join()
        assertFalse("c1" in vm.vetClinicBusyIds.value)
        assertTrue(vm.vetClinicError.value != null)
    }
}
