package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinfolkCreated
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Phase 2 archive + single-save tests. Verifies (a) archiveKinfolk routes through
 * repo.archiveKinfolk (NOT deleteKinfolk), (b) saveKinfolk replaces former
 * saveDraftKinfolk/publishKinfolk split.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelArchiveTest {

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getKinfolk() } returns Result.success(emptyList())
        coEvery { repository.getAllKin() } returns Result.success(emptyList<Kin>())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun seedEditState(id: String = "kf-1", status: String = "active") {
        // Re-stub getKinfolk so loadKinfolkForEdit's fallback path finds the row
        // and populates editKinfolkState.kinfolkId.
        coEvery { repository.getKinfolk() } returns Result.success(
            listOf(Kinfolk(id = id, firstName = "Test", lastName = "User", status = status))
        )
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
        viewModel.loadKinfolkForEdit(id)
    }

    @Test
    fun `archiveKinfolk routes to repository archiveKinfolk with reason`() =
        runTest(testDispatcher) {
            seedEditState()
            advanceUntilIdle()
            coEvery { repository.archiveKinfolk(any(), any(), any()) } returns Result.success(Unit)

            viewModel.archiveKinfolk("moved away")
            advanceUntilIdle()

            coVerify(exactly = 1) {
                repository.archiveKinfolk(any(), "moved away", any())
            }
            coVerify(exactly = 0) { repository.deleteKinfolk(any()) }
            assertTrue(viewModel.editKinfolkState.value.isDeleted)
        }

    @Test
    fun `archiveKinfolk surfaces repo failure`() = runTest(testDispatcher) {
        seedEditState()
        advanceUntilIdle()
        coEvery { repository.archiveKinfolk(any(), any(), any()) } returns
            Result.failure(RuntimeException("denied"))

        viewModel.archiveKinfolk("test")
        advanceUntilIdle()

        assertFalse(viewModel.editKinfolkState.value.isDeleted)
        assertNotNull(viewModel.editKinfolkState.value.error)
        assertTrue(viewModel.editKinfolkState.value.error!!.contains("denied"))
    }

    @Test
    fun `unarchiveKinfolk routes to repository unarchiveKinfolk`() = runTest(testDispatcher) {
        seedEditState(status = "archived")
        advanceUntilIdle()
        coEvery { repository.unarchiveKinfolk(any()) } returns Result.success(Unit)

        viewModel.unarchiveKinfolk()
        advanceUntilIdle()

        coVerify(exactly = 1) { repository.unarchiveKinfolk(any()) }
        assertEquals("active", viewModel.editKinfolkState.value.status)
    }

    @Test
    fun `saveKinfolk requires non-blank first name`() = runTest(testDispatcher) {
        // Default state has blank firstName
        viewModel.saveKinfolk()
        advanceUntilIdle()

        assertNotNull(viewModel.addKinfolkState.value.error)
        assertTrue(viewModel.addKinfolkState.value.error!!.contains("First name"))
        coVerify(exactly = 0) { repository.createKinfolkComplete(any()) }
    }

    @Test
    fun `saveKinfolk defaults blank status to prospect`() = runTest(testDispatcher) {
        coEvery { repository.createKinfolkComplete(any()) } returns Result.success(KinfolkCreated(Kinfolk(id = "new-id"), null))
        coEvery { repository.saveEmergencyContacts(any(), any()) } returns Result.success(emptyList())
        viewModel.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125550190"))
        viewModel.updateFirstName("Pat")

        viewModel.saveKinfolk()
        advanceUntilIdle()

        coVerify(exactly = 1) {
            repository.createKinfolkComplete(match { it.status == "prospect" })
        }
    }

    @Test
    fun `saveKinfolk respects explicit status`() = runTest(testDispatcher) {
        coEvery { repository.createKinfolkComplete(any()) } returns Result.success(KinfolkCreated(Kinfolk(id = "new-id"), null))
        coEvery { repository.saveEmergencyContacts(any(), any()) } returns Result.success(emptyList())
        viewModel.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125550190"))
        viewModel.updateFirstName("Pat")
        viewModel.updateAddStatus("active")

        viewModel.saveKinfolk()
        advanceUntilIdle()

        coVerify(exactly = 1) {
            repository.createKinfolkComplete(match { it.status == "active" })
        }
    }
}
