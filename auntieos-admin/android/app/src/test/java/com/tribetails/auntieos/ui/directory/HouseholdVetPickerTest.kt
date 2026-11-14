package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.SubmitVetClinicResult
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test

/**
 * #1908 kin-vet (owner ruling 2026-11-12): the household vet is a dropdown of
 * the area vet list, settable by the admin. On Android it is picked on
 * Household Data and saved, as the clinic id only, with the rest of the form.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HouseholdVetPickerTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    private val cedar = VetClinic(id = "c1", name = "Cedar Animal Care", phone = "555 0142")
    private val river = VetClinic(id = "c2", name = "Riverside Vets", phone = "555 0199")
    private val nightOwl = VetClinic(id = "er1", name = "Night Owl ER", isEmergency = true)

    private val stored = HouseholdData(id = "hd1", kinfolkId = "kf1", primaryVetClinicId = "c1")

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.getVetClinicsOnce() } returns Result.success(listOf(cedar, river, nightOwl))
        coEvery { repo.getHouseholdData(any()) } returns Result.success(stored)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.loaded(): HouseholdDataViewModel {
        val vm = HouseholdDataViewModel(repository = repo)
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()
        return vm
    }

    @Test
    fun `the picker gets the whole area vet list on open`() = runTest(testDispatcher) {
        val vm = loaded()
        assertEquals(listOf("c1", "c2", "er1"), vm.uiState.value.clinics.map { it.id })
        // Nothing typed: every clinic is offered at once.
        assertEquals(3, vetClinicSuggestions("", vm.uiState.value.clinics).size)
    }

    @Test
    fun `picking a vet saves its clinic id and nothing else`() = runTest(testDispatcher) {
        val changes = slot<Map<String, String>>()
        coEvery { repo.updateHouseholdFields(any(), capture(changes)) } returns Result.success(Unit)
        val vm = loaded()

        vm.selectVetClinic(emergency = false, selection = vetClinicSelectionOf(river))
        assertEquals("Riverside Vets", vm.uiState.value.vet?.primary?.name)
        vm.saveHouseholdData()
        advanceUntilIdle()

        assertEquals(mapOf("primaryVetClinicId" to "c2"), changes.captured)
    }

    @Test
    fun `clearing the vet saves a blank clinic id`() = runTest(testDispatcher) {
        val changes = slot<Map<String, String>>()
        coEvery { repo.updateHouseholdFields(any(), capture(changes)) } returns Result.success(Unit)
        val vm = loaded()

        vm.selectVetClinic(emergency = false, selection = EMPTY_VET_CLINIC_SELECTION)
        vm.saveHouseholdData()
        advanceUntilIdle()

        assertEquals(mapOf("primaryVetClinicId" to ""), changes.captured)
    }

    @Test
    fun `the emergency vet is its own slot`() = runTest(testDispatcher) {
        val changes = slot<Map<String, String>>()
        coEvery { repo.updateHouseholdFields(any(), capture(changes)) } returns Result.success(Unit)
        val vm = loaded()

        vm.selectVetClinic(emergency = true, selection = vetClinicSelectionOf(nightOwl))
        vm.saveHouseholdData()
        advanceUntilIdle()

        assertEquals(mapOf("emergencyVetClinicId" to "er1"), changes.captured)
    }

    @Test
    fun `a clinic added from the picker is picked`() = runTest(testDispatcher) {
        coEvery { repo.submitVetClinicDetailed(any(), any()) } returns
            Result.success(SubmitVetClinicResult(clinicId = "new1", created = true, pending = false))
        val vm = loaded()

        vm.createVetClinic(emergency = false, clinic = VetClinic(name = "Barton Springs Vet"))
        advanceUntilIdle()

        assertEquals("new1", vm.uiState.value.householdData.primaryVetClinicId)
        assertEquals("Barton Springs Vet", vm.uiState.value.vet?.primary?.name)
    }

    @Test
    fun `a near match is not duplicated, and the operator is told to pick it`() = runTest(testDispatcher) {
        coEvery { repo.submitVetClinicDetailed(any(), any()) } returns
            Result.success(SubmitVetClinicResult(clinicId = "", created = false, pending = false, needsChoice = true))
        val vm = loaded()

        vm.createVetClinic(emergency = false, clinic = VetClinic(name = "Cedar Animal"))
        advanceUntilIdle()

        assertEquals("c1", vm.uiState.value.householdData.primaryVetClinicId)
        assertNotNull(vm.uiState.value.error)
        coVerify(exactly = 0) { repo.updateHouseholdFields(any(), any()) }
    }

    @Test
    fun `the selection the picker shows resolves through the clinic`() {
        val vet = resolveHouseholdVet(stored, listOf(cedar))
        assertEquals(VetClinicSelection(clinicId = "c1", name = "Cedar Animal Care", phone = "555 0142"), householdVetSelection("c1", vet.primary))
        assertEquals(EMPTY_VET_CLINIC_SELECTION, householdVetSelection("", ResolvedVet()))
    }
}
