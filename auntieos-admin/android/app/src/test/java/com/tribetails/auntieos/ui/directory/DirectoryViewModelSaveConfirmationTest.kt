package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.KinfolkCreated
import io.mockk.coEvery
import io.mockk.mockk
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * #1009: every kinfolk/kin add, edit and archive success now sets
 * [EditKinfolkUiState.successMessage] (or its Add/Kin siblings) with web's own
 * wording where web has it (`KinfolkEdit.tsx`'s `showToast` calls), so the
 * screen has something to hand `SaveConfirmationHost` before it navigates
 * away in the same `LaunchedEffect`. These are the view-model-level tests for
 * that wiring: what text lands on each state, for each of the paths named in
 * the issue. `SaveConfirmationHostStateTest` covers the host's own state
 * object; `SaveConfirmationHostRenderTest` covers the Compose surface.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelSaveConfirmationTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)

    private val storedKinfolk = Kinfolk(
        id = "kf1",
        firstName = "Ada",
        lastName = "Lovelace",
        phoneNumber = "5551234567",
        email = "ada@example.com",
        status = "active",
        preferredContactMethod = "Text",
    )

    private val storedKin = Kin(
        id = "k1",
        kinfolkId = "kf1",
        name = "Byron",
        breed = "Corgi",
        status = "active",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repo.getKinfolk() } returns Result.success(listOf(storedKinfolk))
        coEvery { repo.getAllKin() } returns Result.success(listOf(storedKin))
        coEvery { repo.getKin(any()) } returns Result.success(listOf(storedKin))
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.get411ForKin(any()) } returns Result.failure(NoSuchElementException("none"))
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { repo.getHouseholdData(any()) } returns Result.success(null)
        coEvery { repo.getVetClinicsOnce() } returns Result.success(emptyList())
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { invoiceRepo.getInvoicesForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.updateKinfolkFields(any(), any()) } returns Result.success(Unit)
        coEvery { repo.updateKinFields(any(), any(), any()) } returns Result.success(Unit)
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf(storedKin.id to storedKin))
        coEvery { repo.getKinfolkById(any()) } returns Result.success(storedKinfolk)
        coEvery { repo.archiveKinfolk(any(), any(), any()) } returns Result.success(Unit)
        coEvery { repo.unarchiveKinfolk(any()) } returns Result.success(Unit)
        coEvery { repo.createKinfolkComplete(any(), any()) } returns
            Result.success(KinfolkCreated(Kinfolk(id = "new-kf", firstName = "Pat", lastName = "Nguyen"), null))
        coEvery { repo.saveEmergencyContacts(any(), any()) } returns Result.success(emptyList())
        coEvery { repo.createKin(any()) } returns Result.success(Kin(id = "new-kin", name = "Scout"))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun TestScope.viewModel(): DirectoryViewModel {
        val vm = DirectoryViewModel(repo, invoiceRepo, kinCareRepo)
        advanceUntilIdle()
        return vm
    }

    private fun TestScope.kinfolkEditor(): DirectoryViewModel {
        val vm = viewModel()
        vm.loadKinfolkForEdit(storedKinfolk.id)
        advanceUntilIdle()
        return vm
    }

    private fun TestScope.kinEditor(): DirectoryViewModel {
        val vm = viewModel()
        vm.loadProfile(storedKin.kinfolkId)
        advanceUntilIdle()
        vm.loadKinForEdit(storedKin.id)
        advanceUntilIdle()
        return vm
    }

    // ── Add Kinfolk ──────────────────────────────────────────────────────────

    @Test
    fun `saving a new household sets an Added confirmation`() = runTest(testDispatcher) {
        val vm = viewModel()
        vm.updateFirstName("Pat")
        vm.updateLastName("Nguyen")
        vm.updateEmail("pat@example.com")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125550190"))

        vm.saveKinfolk()
        advanceUntilIdle()

        assertEquals("Added Pat Nguyen.", vm.addKinfolkState.value.successMessage)
    }

    @Test
    fun `clearAddKinfolkSuccessMessage consumes the message without touching isSuccess`() = runTest(testDispatcher) {
        val vm = viewModel()
        vm.updateFirstName("Pat")
        vm.updateLastName("Nguyen")
        vm.updateEmail("pat@example.com")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125550190"))
        vm.saveKinfolk()
        advanceUntilIdle()

        vm.clearAddKinfolkSuccessMessage()

        assertNull(vm.addKinfolkState.value.successMessage)
        assertEquals(true, vm.addKinfolkState.value.isSuccess)
    }

    // ── Edit Kinfolk (save) ──────────────────────────────────────────────────

    @Test
    fun `saving an edited household matches web's wording`() = runTest(testDispatcher) {
        val vm = kinfolkEditor()
        vm.updateEditInternalNotes("gate sticks, lift and push")

        vm.saveKinfolkChanges()
        advanceUntilIdle()

        // web: KinfolkEdit.tsx `showToast(\`Saved ${displayName}.\`)`.
        assertEquals("Saved Ada Lovelace.", vm.editKinfolkState.value.successMessage)
    }

    @Test
    fun `saving an untouched household still confirms - saved and nothing to save are the same outcome`() =
        runTest(testDispatcher) {
            val vm = kinfolkEditor()

            vm.saveKinfolkChanges()
            advanceUntilIdle()

            assertEquals("Saved Ada Lovelace.", vm.editKinfolkState.value.successMessage)
        }

    // ── Edit Kinfolk (archive / unarchive) ───────────────────────────────────

    @Test
    fun `archiving a household matches web's wording`() = runTest(testDispatcher) {
        val vm = kinfolkEditor()

        vm.archiveKinfolk("moved away")
        advanceUntilIdle()

        // web: KinfolkEdit.tsx `showToast(\`${displayName} is archived.\`)`.
        assertEquals("Ada Lovelace is archived.", vm.editKinfolkState.value.successMessage)
    }

    @Test
    fun `unarchiving a household matches web's wording and needs no navigation to show it`() =
        runTest(testDispatcher) {
            val vm = kinfolkEditor()

            vm.unarchiveKinfolk()
            advanceUntilIdle()

            // web: KinfolkEdit.tsx `showToast(\`${displayName} is active again.\`)`.
            assertEquals("Ada Lovelace is active again.", vm.editKinfolkState.value.successMessage)
            // Unlike a save or an archive, this path sets no isSuccess/isDeleted:
            // the operator stays on this editor, and the message is the only
            // thing that changed.
            assertEquals(false, vm.editKinfolkState.value.isSuccess)
            assertEquals(false, vm.editKinfolkState.value.isDeleted)
        }

    // ── Add Kin ──────────────────────────────────────────────────────────────

    @Test
    fun `adding a pet sets an Added confirmation`() = runTest(testDispatcher) {
        val vm = viewModel()
        vm.setKinfolkForNewKin(storedKinfolk.id)
        vm.updateKinName("Scout")

        vm.saveKin()
        advanceUntilIdle()

        assertEquals("Added Scout.", vm.addKinState.value.successMessage)
    }

    // ── Edit Kin (save) ──────────────────────────────────────────────────────

    @Test
    fun `saving an edited pet follows the household editor's wording`() = runTest(testDispatcher) {
        val vm = kinEditor()
        vm.updateEditKinBreed("Pomeranian")

        vm.saveKinChanges()
        advanceUntilIdle()

        assertEquals("Saved Byron.", vm.editKinState.value.successMessage)
    }

    @Test
    fun `saving an untouched pet still confirms`() = runTest(testDispatcher) {
        val vm = kinEditor()

        vm.saveKinChanges()
        advanceUntilIdle()

        assertEquals("Saved Byron.", vm.editKinState.value.successMessage)
    }

    // ── Edit Kin (archive / restore) ─────────────────────────────────────────

    @Test
    fun `archiving a pet follows the household editor's wording`() = runTest(testDispatcher) {
        val vm = kinEditor()

        vm.setKinArchived(true)
        advanceUntilIdle()

        assertEquals("Byron is archived.", vm.editKinState.value.successMessage)
    }

    @Test
    fun `restoring an already-active pet still confirms - the no-op branch matches the real-write branch`() =
        runTest(testDispatcher) {
            val vm = kinEditor()

            // storedKin is already "active"; setKinArchived(false) is the no-op path.
            vm.setKinArchived(false)
            advanceUntilIdle()

            assertEquals("Byron is active again.", vm.editKinState.value.successMessage)
        }

    @Test
    fun `clearEditKinSuccessMessage consumes the message`() = runTest(testDispatcher) {
        val vm = kinEditor()
        vm.setKinArchived(true)
        advanceUntilIdle()

        vm.clearEditKinSuccessMessage()

        assertNull(vm.editKinState.value.successMessage)
    }
}
