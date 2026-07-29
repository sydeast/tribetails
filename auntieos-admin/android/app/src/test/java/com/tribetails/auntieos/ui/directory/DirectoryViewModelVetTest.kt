package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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
import org.junit.Before
import org.junit.Test

/**
 * 1D: vet is single-source on the Kinfolk (household). The Kin edit screen shows it
 * READ-ONLY, inherited from the owning Kinfolk. These tests pin that the edit state
 * carries the parent household's vet so the screen can render it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelVetTest {

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    private val kinfolkWithVet = Kinfolk(
        id = "kf1",
        firstName = "Sandy",
        lastName = "Thorne",
        phoneNumber = "555-100-2000",
        status = "active",
        vetClinicName = "Riverside Animal Hospital",
        vetClinicPhone = "555-867-5309",
        vetClinicAddress = "12 River Rd",
    )
    private val kin = Kin(id = "k1", kinfolkId = "kf1", name = "Biscuit", species = "Dog")

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getKinfolk() } returns Result.success(listOf(kinfolkWithVet))
        coEvery { repository.getAllKin() } returns Result.success(listOf(kin))
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repository.getKin("kf1") } returns Result.success(listOf(kin))
        coEvery { repository.getDossier(any()) } returns Result.success(null)
        coEvery { kinCareRepository.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { kinCareRepository.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { invoiceRepository.getInvoicesForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repository.get411ForKin(any()) } returns Result.failure(NoSuchElementException("none"))
        // Phase 2: loadProfile now reads HouseholdData for the dossier migration box.
        coEvery { repository.getHouseholdData(any()) } returns Result.success(null)
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `loadKinForEdit inherits household vet from owning Kinfolk`() = runTest(testDispatcher) {
        advanceUntilIdle()
        viewModel.loadProfile("kf1")
        advanceUntilIdle()
        viewModel.loadKinForEdit("k1")
        advanceUntilIdle()

        val s = viewModel.editKinState.value
        assertEquals("Riverside Animal Hospital", s.householdVetName)
        assertEquals("555-867-5309", s.householdVetPhone)
        assertEquals("12 River Rd", s.householdVetAddress)
        assertEquals("Sandy Thorne", s.householdName)
    }
}
