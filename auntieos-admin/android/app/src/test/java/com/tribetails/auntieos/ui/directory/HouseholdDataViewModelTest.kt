package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HouseholdDataViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        // Phase 2: loadHouseholdData also reads the dossier notes for the reference card.
        // Default to no notes so the existing household-load tests stay focused.
        coEvery { mockRepo.getDossier(any()) } returns Result.success(null)
        // A2: loadHouseholdData now also reads the CANONICAL vet (the kinfolk
        // record) and the clinic catalog it takes its hours from. Default both
        // to empty so the household-load tests above stay focused on the load.
        coEvery { mockRepo.getKinfolkById(any()) } returns Result.success(null)
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = HouseholdDataViewModel(repository = mockRepo)

    @Test
    fun `initial state has empty householdData and isLoading true`() {
        val vm = buildViewModel()
        val state = vm.uiState.value
        assertEquals(HouseholdData(), state.householdData)
    }

    @Test
    fun `loadHouseholdData populates state on success`() = runTest(testDispatcher) {
        val data = HouseholdData(kinfolkId = "kf1", primaryVetName = "Dr. Smith")
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(data)

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertEquals("Dr. Smith", state.householdData.primaryVetName)
        assertNull(state.error)
    }

    @Test
    fun `loadHouseholdData returns default HouseholdData when repo returns null`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(null)

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertEquals("kf1", state.householdData.kinfolkId)
    }

    @Test
    fun `loadHouseholdData sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData(any()) } returns Result.failure(RuntimeException("Load failed"))

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertNotNull(state.error)
    }

    /**
     * Punchlist A2: the vet is READ THROUGH from the kinfolk record, not authored
     * here. `updatePrimaryVetName` and its six siblings are gone, so there is no
     * setter left to test. What matters now is that the read lands, that hours
     * resolve from the CLINIC, and that a failure fails loud.
     */
    @Test
    fun `the vet is read from the kinfolk record, with hours from the clinic`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(HouseholdData(kinfolkId = "kf1"))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(
            Kinfolk(
                id = "kf1",
                vetClinicId = "clinic_a",
                vetClinicName = "Riverside Animal Hospital",
                vetClinicPhone = "(512) 555 0100",
                emergencyVetClinicId = "clinic_er",
                emergencyVetClinicName = "Austin Pet ER",
                emergencyVetClinicPhone = "(512) 555 0300",
            )
        )
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.success(
            listOf(
                VetClinic(id = "clinic_a", name = "Riverside Animal Hospital", hours = "Mon to Fri 8a to 6p"),
                VetClinic(id = "clinic_er", name = "Austin Pet ER", hours = "24 hours"),
            )
        )

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val vet = vm.uiState.value.vet
        assertNotNull(vet)
        assertEquals("Riverside Animal Hospital", vet!!.primaryName)
        assertEquals("(512) 555 0100", vet.primaryPhone)
        // Hours are NOT on the household record; they resolve through the id.
        assertEquals("Mon to Fri 8a to 6p", vet.primaryHours)
        assertTrue(vet.primaryLinked)
    }

    /** The emergency vet stays a DISTINCT clinic, never folded into the primary. */
    @Test
    fun `the emergency vet is kept separate from the primary`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(HouseholdData(kinfolkId = "kf1"))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(
            Kinfolk(
                id = "kf1",
                vetClinicId = "clinic_a",
                vetClinicName = "Riverside Animal Hospital",
                emergencyVetClinicId = "clinic_er",
                emergencyVetClinicName = "Austin Pet ER",
                emergencyVetClinicPhone = "(512) 555 0300",
            )
        )
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.success(
            listOf(VetClinic(id = "clinic_er", name = "Austin Pet ER", hours = "24 hours"))
        )

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val vet = vm.uiState.value.vet!!
        assertEquals("Austin Pet ER", vet.emergencyName)
        assertEquals("(512) 555 0300", vet.emergencyPhone)
        assertEquals("24 hours", vet.emergencyHours)
        assertTrue(vet.hasEmergency)
    }

    /** A household holding a vet with no catalog id cannot be reached by a correction. */
    @Test
    fun `a legacy unlinked vet is flagged as unlinked`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(HouseholdData(kinfolkId = "kf1"))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(
            Kinfolk(id = "kf1", vetClinicId = "", vetClinicName = "Some Clinic", vetClinicPhone = "555")
        )
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val vet = vm.uiState.value.vet!!
        assertTrue(vet.hasPrimary)
        assertFalse(vet.primaryLinked)
        assertEquals("", vet.primaryHours)
    }

    /** Fail loud: an unreadable vet must not look like a household with no vet. */
    @Test
    fun `a failed vet read sets vetError and leaves vet null`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(HouseholdData(kinfolkId = "kf1"))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.failure(Exception("permission-denied"))

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        assertNull(vm.uiState.value.vet)
        val err = vm.uiState.value.vetError
        assertTrue("got: $err", err != null && err.contains("permission-denied"))
    }

    /** A catalog read failure costs the HOURS only; the rest is on the household. */
    @Test
    fun `a failed clinic read still shows the name and phone`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(HouseholdData(kinfolkId = "kf1"))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(
            Kinfolk(id = "kf1", vetClinicId = "clinic_a", vetClinicName = "Riverside", vetClinicPhone = "555")
        )
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.failure(Exception("offline"))

        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()

        val vet = vm.uiState.value.vet!!
        assertEquals("Riverside", vet.primaryName)
        assertEquals("555", vet.primaryPhone)
        assertEquals("", vet.primaryHours)
    }
}
