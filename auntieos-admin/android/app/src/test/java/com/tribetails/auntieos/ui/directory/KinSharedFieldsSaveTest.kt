package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.CapturingSlot
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1908 (owner ruling 2026-11-11): admin Edit kin gets a box for every field
 * the household fills (feeding, walking, allergies, emergency notes, notes for
 * the Auntie), and the Kin vet is the household's unless "Different vet for
 * this Kin" is ticked. Every save still writes only what changed.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinSharedFieldsSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)

    private val cedar = VetClinic(id = "c1", name = "Cedar Animal Care", phone = "555 0142")
    private val river = VetClinic(id = "c2", name = "Riverside Vets", phone = "555 0199")

    /** A Kin as an older doc stores it: the household's care block cleared to null. */
    private val storedKin = Kin(
        id = "k1",
        kinfolkId = "kf1",
        name = "Byron",
        feedingInstructions = null,
        walkingInstructions = "Short loop",
        allergies = null,
        emergencyNotes = null,
        sitterNotes = null,
        ownVetClinicId = null,
        familyKinPath = "families/kf1/kin/k1",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf(storedKin.id to storedKin))
        coEvery { repo.getKinfolkById(any()) } returns Result.success(Kinfolk(id = "kf1", firstName = "Ada", lastName = "Wren"))
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { repo.getHouseholdData(any()) } returns Result.success(HouseholdData(primaryVetClinicId = "c1"))
        coEvery { repo.getVetClinicsOnce() } returns Result.success(
            listOf(cedar, river, VetClinic(id = "c3", name = "Old Clinic", archived = true)),
        )
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        // The view model reads the Directory when it starts.
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.getAllKin() } returns Result.success(listOf(storedKin))
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun captureKinChanges(): CapturingSlot<Map<String, Any>> {
        val changes = slot<Map<String, Any>>()
        coEvery { repo.updateKinFields(any(), any(), capture(changes), any()) } returns Result.success(Unit)
        return changes
    }

    private fun TestScope.editor(kin: Kin = storedKin): DirectoryViewModel {
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf(kin.id to kin))
        val vm = DirectoryViewModel(repo, invoiceRepo, kinCareRepo)
        vm.loadKinForEdit(kin.id)
        advanceUntilIdle()
        return vm
    }

    @Test
    fun `a Kin whose care block was cleared to null opens with blank boxes`() = runTest(testDispatcher) {
        val s = editor().editKinState.value
        assertEquals("", s.feedingInstructions)
        assertEquals("Short loop", s.walkingInstructions)
        assertEquals("", s.allergies)
        assertEquals("", s.emergencyNotes)
        assertEquals("", s.sitterNotes)
    }

    @Test
    fun `an untouched Kin whose fields are null writes nothing`() = runTest(testDispatcher) {
        val vm = editor()
        vm.saveKinChanges()
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.updateKinFields(any(), any(), any(), any()) }
    }

    @Test
    fun `each new box writes only its own field`() = runTest(testDispatcher) {
        val cases: List<Triple<String, String, (DirectoryViewModel, String) -> Unit>> = listOf(
            Triple("feedingInstructions", "1 cup AM", { vm, v -> vm.updateEditKinFeedingInstructions(v) }),
            Triple("walkingInstructions", "Long loop", { vm, v -> vm.updateEditKinWalkingInstructions(v) }),
            Triple("allergies", "Chicken", { vm, v -> vm.updateEditKinAllergies(v) }),
            Triple("emergencyNotes", "Call the vet first", { vm, v -> vm.updateEditKinEmergencyNotes(v) }),
            Triple("sitterNotes", "Leash by the door", { vm, v -> vm.updateEditKinSitterNotes(v) }),
        )
        for ((field, value, set) in cases) {
            val changes = captureKinChanges()
            val vm = editor()
            set(vm, value)
            vm.saveKinChanges()
            advanceUntilIdle()
            assertEquals("$field alone", mapOf(field to value), changes.captured)
        }
    }

    @Test
    fun `the household vet shows read-only and the box starts unticked`() = runTest(testDispatcher) {
        val s = editor().editKinState.value
        assertFalse(s.differentVet)
        assertEquals("Cedar Animal Care", s.householdVetName)
        // Every clinic a household may pick, the archived one left out.
        assertEquals(listOf("c1", "c2"), s.vetClinicOptions.map { it.id })
    }

    @Test
    fun `ticking the box and picking a clinic saves it as the Kin vet`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = editor()
        vm.updateEditKinDifferentVet(true)
        vm.updateEditKinOwnVetClinic("c2")
        vm.saveKinChanges()
        advanceUntilIdle()
        assertEquals(mapOf("ownVetClinicId" to "c2"), changes.captured)
    }

    @Test
    fun `ticking the box without picking writes nothing`() = runTest(testDispatcher) {
        val vm = editor()
        vm.updateEditKinDifferentVet(true)
        vm.saveKinChanges()
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.updateKinFields(any(), any(), any(), any()) }
    }

    @Test
    fun `a Kin with its own vet opens ticked, and unticking goes back to the household vet`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = editor(storedKin.copy(ownVetClinicId = "c2"))
        assertTrue(vm.editKinState.value.differentVet)
        assertEquals("c2", vm.editKinState.value.ownVetClinicId)
        vm.updateEditKinDifferentVet(false)
        vm.saveKinChanges()
        advanceUntilIdle()
        assertEquals(mapOf("ownVetClinicId" to ""), changes.captured)
    }

    @Test
    fun `the new keys are in the diff, and a null equals a blank`() {
        val loaded = Kin(id = "k1", allergies = null, ownVetClinicId = null)
        assertEquals(emptyMap<String, Any>(), kinFieldChanges(loaded, loaded.copy(allergies = "", ownVetClinicId = "")))
        for (key in listOf("feedingInstructions", "walkingInstructions", "allergies", "emergencyNotes", "sitterNotes", "ownVetClinicId")) {
            assertTrue("$key is diffed", KIN_DIFF_FIELDS.containsKey(key))
        }
    }
}
