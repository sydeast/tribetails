package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.CapturingSlot
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.slot
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
import org.junit.Before
import org.junit.Test

/**
 * Regression guard for the cross-platform photo-wipe bug.
 *
 * The saves used to rebuild the entity from scratch and persist it via
 * `.set()`, so a rebuild that dropped `profilePictureUrl` wiped a photo
 * uploaded on web or android. They write a DIFF against the loaded record now
 * (see `DirectoryFieldChanges.kt`), which MOVES the guarantee rather than
 * removing it: an unrelated edit no longer carries the photo at a stale value,
 * it does not mention the photo AT ALL. That is strictly stronger - a photo
 * replaced on the web after this screen loaded survives too - so these tests
 * assert the field is absent from the write.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelPhotoTest {

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    private val kinfolkWithPhoto = Kinfolk(
        id = "kf1",
        firstName = "John",
        lastName = "Doe",
        phoneNumber = "555-123-4567",
        status = "active",
        profilePictureUrl = "https://cdn.example.com/kf1.jpg",
    )
    private val kinWithPhoto = Kin(
        id = "k1",
        kinfolkId = "kf1",
        name = "Buddy",
        species = "Dog",
        profilePictureUrl = "https://cdn.example.com/k1.jpg",
    )

    // The kin detail resolves the household vet through the catalog now.
    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getKinfolk() } returns Result.success(listOf(kinfolkWithPhoto))
        coEvery { repository.getAllKin() } returns Result.success(listOf(kinWithPhoto))
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repository.getKin("kf1") } returns Result.success(listOf(kinWithPhoto))
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
    fun `saveKinfolkChanges never writes profilePictureUrl it did not change`() = runTest(testDispatcher) {
        advanceUntilIdle()
        val captured: CapturingSlot<Map<String, Any>> = slot()
        coEvery { repository.updateKinfolkFields(any(), capture(captured)) } returns Result.success(Unit)

        viewModel.loadKinfolkForEdit("kf1")
        advanceUntilIdle()
        viewModel.updateEditInternalNotes("gate sticks")
        viewModel.saveKinfolkChanges()
        advanceUntilIdle()

        assertEquals(setOf("internalNotes"), captured.captured.keys)
    }

    @Test
    fun `saveKinChanges never writes profilePictureUrl it did not change`() = runTest(testDispatcher) {
        advanceUntilIdle()
        val captured: CapturingSlot<Map<String, Any>> = slot()
        coEvery { repository.updateKinFields(any(), any(), capture(captured)) } returns Result.success(Unit)
        // loadKinForEdit resolves the household vet from household_data through
        // the clinic catalog now; a relaxed mock cannot answer either usefully.
        coEvery { repository.getHouseholdData(any()) } returns Result.success(null)
        coEvery { repository.getVetClinicsOnce() } returns Result.success(emptyList())

        viewModel.loadProfile("kf1")
        advanceUntilIdle()
        viewModel.loadKinForEdit("k1")
        advanceUntilIdle()
        viewModel.updateEditKinBreed("Corgi")
        viewModel.saveKinChanges()
        advanceUntilIdle()

        assertEquals(setOf("breed"), captured.captured.keys)
    }

    /**
     * A photo the WEB replaced after this screen loaded survives an unrelated
     * save here. This is the half the old whole-model write could not give: it
     * carried `profilePictureUrl` at the value the phone had read, so the newer
     * photo went back to the older one.
     */
    @Test
    fun `a photo replaced on the web after the load survives an unrelated save`() = runTest(testDispatcher) {
        advanceUntilIdle()
        val captured: CapturingSlot<Map<String, Any>> = slot()
        coEvery { repository.updateKinfolkFields(any(), capture(captured)) } returns Result.success(Unit)

        viewModel.loadKinfolkForEdit("kf1")   // phone holds .../kf1.jpg
        advanceUntilIdle()
        viewModel.updateEditInternalNotes("gate sticks")
        viewModel.saveKinfolkChanges()
        advanceUntilIdle()

        assertFalse(
            "the stale photo url must not be written: ${captured.captured}",
            captured.captured.containsKey("profilePictureUrl"),
        )
    }
}
