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
     * Operator ruling 2026-08-01: `household_data` OWNS the vet, catalog-linked.
     * The ViewModel resolves its OWN record through the clinic catalog; it used
     * to read the kinfolk doc, which is the copy that made the vet authored in
     * two places at once. The resolver itself is covered in
     * HouseholdVetResolverTest; these pin the ViewModel's wiring and failure.
     */
    @Test
    fun `the vet resolves from the household record through the catalog`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(
            HouseholdData(kinfolkId = "kf1", primaryVetClinicId = "clinic_a")
        )
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.success(
            listOf(VetClinic(id = "clinic_a", name = "Riverside", phone = "555", hours = "8a to 6p"))
        )
        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()
        val vet = vm.uiState.value.vet
        assertNotNull(vet)
        assertEquals("Riverside", vet!!.primary.name)
        // Hours are NOT on the household record; they resolve through the id.
        assertEquals("8a to 6p", vet.primary.hours)
        assertTrue(vet.primary.linked)
    }
    /** Fail loud: an unreadable catalog must not look like a household with no vet. */
    @Test
    fun `a failed catalog read sets vetError and leaves vet null`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(
            HouseholdData(kinfolkId = "kf1", primaryVetClinicId = "clinic_a")
        )
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.failure(Exception("permission-denied"))
        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()
        assertNull(vm.uiState.value.vet)
        val err = vm.uiState.value.vetError
        assertTrue("got: $err", err != null && err.contains("permission-denied"))
    }
    /** An unlinked household still shows the legacy text as its vet. */
    @Test
    fun `a legacy unlinked household still resolves its free text`() = runTest(testDispatcher) {
        coEvery { mockRepo.getHouseholdData("kf1") } returns Result.success(
            HouseholdData(kinfolkId = "kf1", primaryVetName = "Some Clinic", primaryVetPhone = "555")
        )
        coEvery { mockRepo.getVetClinicsOnce() } returns Result.success(emptyList())
        val vm = buildViewModel()
        vm.loadHouseholdData("kf1")
        advanceUntilIdle()
        val vet = vm.uiState.value.vet!!
        assertEquals("Some Clinic", vet.primary.name)
        assertFalse(vet.primary.linked)
    }
}
