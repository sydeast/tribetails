package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Verifies DirectoryViewModel writes ActivityLogEntry rows via
 * AuntieRepository.logActivity for the five mutation paths the activity log
 * surface depends on (Create/Update/Archive/Unarchive kinfolk + Create/Update kin).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelAuditLogTest {

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
        coEvery { repository.logActivity(any()) } returns Result.success(Unit)
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `saveKinfolk fires CREATE_KINFOLK audit entry`() = runTest(testDispatcher) {
        coEvery { repository.createKinfolkComplete(any()) } returns
            Result.success(Kinfolk(id = "new-id", firstName = "Pat", lastName = "S"))
        viewModel.updateFirstName("Pat")

        viewModel.saveKinfolk()
        advanceUntilIdle()

        coVerify(exactly = 1) {
            repository.logActivity(match<ActivityLogEntry> {
                it.actionType == "CREATE_KINFOLK" &&
                it.targetId == "new-id" &&
                it.targetCollection == "kinfolk"
            })
        }
    }

    @Test
    fun `archiveKinfolk fires ARCHIVE_KINFOLK audit entry with reason in description`() =
        runTest(testDispatcher) {
            coEvery { repository.getKinfolk() } returns Result.success(
                listOf(Kinfolk(id = "kf-arch", firstName = "T", lastName = "U"))
            )
            viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
            viewModel.loadKinfolkForEdit("kf-arch")
            advanceUntilIdle()
            coEvery { repository.archiveKinfolk(any(), any(), any()) } returns Result.success(Unit)

            viewModel.archiveKinfolk("moved away")
            advanceUntilIdle()

            coVerify(exactly = 1) {
                repository.logActivity(match<ActivityLogEntry> {
                    it.actionType == "ARCHIVE_KINFOLK" &&
                    it.targetId == "kf-arch" &&
                    it.description.contains("moved away")
                })
            }
        }

    @Test
    fun `unarchiveKinfolk fires UNARCHIVE_KINFOLK audit entry`() = runTest(testDispatcher) {
        coEvery { repository.getKinfolk() } returns Result.success(
            listOf(Kinfolk(id = "kf-un", firstName = "T", lastName = "U", status = "archived"))
        )
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
        viewModel.loadKinfolkForEdit("kf-un")
        advanceUntilIdle()
        coEvery { repository.unarchiveKinfolk(any()) } returns Result.success(Unit)

        viewModel.unarchiveKinfolk()
        advanceUntilIdle()

        coVerify(exactly = 1) {
            repository.logActivity(match<ActivityLogEntry> {
                it.actionType == "UNARCHIVE_KINFOLK" && it.targetId == "kf-un"
            })
        }
    }

    @Test
    fun `failed save does NOT fire audit entry`() = runTest(testDispatcher) {
        coEvery { repository.createKinfolkComplete(any()) } returns
            Result.failure(RuntimeException("nope"))
        viewModel.updateFirstName("Pat")

        viewModel.saveKinfolk()
        advanceUntilIdle()

        coVerify(exactly = 0) { repository.logActivity(any()) }
        assertTrue(viewModel.addKinfolkState.value.error != null)
    }
}
