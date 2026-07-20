package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelTest {

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        
        val kinfolkList = listOf(
            Kinfolk(id = "1", firstName = "John", lastName = "Doe", status = "active"),
            Kinfolk(id = "2", firstName = "Jane", lastName = "Smith", status = "inactive")
        )
        coEvery { repository.getKinfolk() } returns Result.success(kinfolkList)
        coEvery { repository.getAllKin() } returns Result.success(emptyList<Kin>())
        coEvery { repository.getKinCareSessions() } returns Result.success(emptyList())

        // loadProfile dependencies + the Phase 2 household-notes migration methods.
        // Stub every read loadProfile makes so a found-kinfolk profile load resolves
        // cleanly under the (relaxed) mock and the new getHouseholdData call is exercised.
        coEvery { repository.getDossier(any()) } returns Result.success(null)
        coEvery { repository.getKin(any()) } returns Result.success(emptyList())
        coEvery { repository.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { repository.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repository.getInvoicesForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repository.getHouseholdData(any()) } returns Result.success(null)
        coEvery { repository.listFormSchemas() } returns Result.success(emptyList())
        coEvery { repository.clearDossierHouseholdNotes(any()) } returns Result.success(Unit)
        // Phase 3: refresh-intelligence (synthesize) on the directory VM.
        coEvery { repository.synthesizeProfile(any()) } returns Result.success(Unit)

        viewModel = DirectoryViewModel(repository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `loadDirectory updates state with all kinfolk`() = runTest(testDispatcher) {
        advanceUntilIdle()

        val state = viewModel.directoryState.value
        assertFalse(state.isLoading)
        assertEquals(2, state.allKinfolk.size)
        assertEquals(1, state.displayedKinfolk.size) // Default filter is "Active"
    }

    @Test
    fun `search updates displayed kinfolk`() = runTest(testDispatcher) {
        advanceUntilIdle()

        viewModel.search("Jane")
        viewModel.setStatusFilter("All")
        advanceUntilIdle()

        val state = viewModel.directoryState.value
        assertEquals("Jane", state.searchQuery)
        assertEquals(1, state.displayedKinfolk.size)
        assertEquals("Jane", state.displayedKinfolk[0].firstName)
    }

    @Test
    fun `setStatusFilter updates displayed kinfolk`() = runTest(testDispatcher) {
        advanceUntilIdle()

        viewModel.setStatusFilter("Inactive")

        val state = viewModel.directoryState.value
        assertEquals(1, state.displayedKinfolk.size)
        assertEquals("Jane", state.displayedKinfolk[0].firstName)
    }

    // Phase 2: loadProfile loads the structured HouseholdData that backs the
    // dossier migration box's gap list.
    @Test
    fun `loadProfile populates householdData from repository`() = runTest(testDispatcher) {
        advanceUntilIdle()
        val household = HouseholdData(kinfolkId = "1", primaryVetName = "Dr. Vet")
        coEvery { repository.getHouseholdData("1") } returns Result.success(household)

        viewModel.loadProfile("1")
        advanceUntilIdle()

        val state = viewModel.profileState.value
        assertEquals("Dr. Vet", state.householdData?.primaryVetName)
    }

    // Phase 2: clearDossierHouseholdNotes calls the repo, then reloads the profile so
    // the one-shot migration box hides.
    @Test
    fun `clearDossierHouseholdNotes calls repo then reloads profile`() = runTest(testDispatcher) {
        advanceUntilIdle()
        // Seed a profile so the reload has a found kinfolk to resolve.
        viewModel.loadProfile("1")
        advanceUntilIdle()

        viewModel.clearDossierHouseholdNotes("1")
        advanceUntilIdle()

        coVerify { repository.clearDossierHouseholdNotes("1") }
        // The reload re-reads the profile dependencies (getDossier here is the witness).
        coVerify(atLeast = 2) { repository.getDossier("1") }
        assertEquals("Cleared household notes from the dossier.", viewModel.clearMessage.value)
        assertNull(viewModel.profileState.value.error)
    }

    // Phase 3: synthesizeProfile (Refresh intelligence) re-runs synthesis for the
    // household, then reloads the profile so the new dossier/411 show.
    @Test
    fun `synthesizeProfile calls repo then reloads profile and sets message`() = runTest(testDispatcher) {
        advanceUntilIdle()
        viewModel.loadProfile("1")
        advanceUntilIdle()

        viewModel.synthesizeProfile("1")
        advanceUntilIdle()

        coVerify { repository.synthesizeProfile("1") }
        coVerify(atLeast = 2) { repository.getDossier("1") }   // reloaded
        assertEquals("Profile updated from recent history.", viewModel.synthesizeMessage.value)
        assertFalse(viewModel.isSynthesizing.value)
    }

    @Test
    fun `synthesizeProfile surfaces error on failure`() = runTest(testDispatcher) {
        coEvery { repository.synthesizeProfile(any()) } returns Result.failure(RuntimeException("boom"))
        advanceUntilIdle()

        viewModel.synthesizeProfile("1")
        advanceUntilIdle()

        assertEquals("Refresh failed: boom", viewModel.synthesizeMessage.value)
        assertFalse(viewModel.isSynthesizing.value)
    }

    @Test
    fun `synthesizeProfile with blank id does not call repo`() = runTest(testDispatcher) {
        advanceUntilIdle()
        viewModel.synthesizeProfile("")
        advanceUntilIdle()
        coVerify(exactly = 0) { repository.synthesizeProfile(any()) }
        assertEquals("No household selected for refresh.", viewModel.synthesizeMessage.value)
    }
}
