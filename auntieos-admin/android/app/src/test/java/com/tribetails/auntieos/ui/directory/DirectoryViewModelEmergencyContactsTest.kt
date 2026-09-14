package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.data.model.EMERGENCY_CONTACT_REQUIRED
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
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * `loadKinfolkForEdit` finds the household by scanning the directory it
 * already holds and, failing that, a fresh `repository.getKinfolk()` list -
 * never `getKinfolkById` (that call belongs to the Kin cold-arrival path, see
 * `DirectorySaveTest`). The two edit-path tests below stub `getKinfolk()` with
 * the target household in the list rather than `getKinfolkById`, to match.
 *
 * `getAllKin()` and `getKinCareSessions()` are stubbed too, even though no
 * test here asserts on them: `saveNewHouseholdContacts` calls `loadDirectory()`
 * on both its success and failure branch, and `loadDirectory()` reads both. A
 * relaxed mock's synthesized answer for an unstubbed `Result<List<T>>>` is not
 * actually a list, so `loadDirectory()`'s `.groupBy` throws a
 * ClassCastException inside an un-awaited `launch` - silently swallowed, then
 * reported by kotlinx-coroutines-test as an "uncaught exception" on whichever
 * unrelated test happens to call `runTest` next.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelEmergencyContactsTest {

    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
    private lateinit var vm: DirectoryViewModel

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        vm = DirectoryViewModel(repo, mockk<InvoiceRepository>(relaxed = true), kinCareRepo)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `add refuses to create a household without an Emergency Contact`() {
        vm.updateFirstName("Jamie")
        vm.saveKinfolk()
        assertEquals(EMERGENCY_CONTACT_REQUIRED, vm.addKinfolkState.value.error)
        coVerify(exactly = 0) { repo.createKinfolkComplete(any()) }
    }

    @Test
    fun `add creates the household, then saves the contact against the new id`() {
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(firstArg<Kinfolk>().copy(id = "kf-new")) }
        coEvery { repo.saveEmergencyContacts("kf-new", any()) } returns Result.success(emptyList())
        vm.updateFirstName("Jamie")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125559090"))
        vm.saveKinfolk()
        coVerify { repo.saveEmergencyContacts("kf-new", listOf(EmergencyContactDraft("Rae Halbrook", "5125559090"))) }
        assertTrue(vm.addKinfolkState.value.isSuccess)
    }

    @Test
    fun `a failed contact save keeps the new id so a retry never creates a second household`() {
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(firstArg<Kinfolk>().copy(id = "kf-new")) }
        coEvery { repo.saveEmergencyContacts("kf-new", any()) } returnsMany listOf(Result.failure(Exception("offline")), Result.success(emptyList()))
        vm.updateFirstName("Jamie")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125559090"))
        vm.saveKinfolk()
        assertEquals("kf-new", vm.addKinfolkState.value.createdKinfolkId)
        assertTrue(vm.addKinfolkState.value.error.orEmpty().startsWith("saveEmergencyContacts failed"))
        vm.saveKinfolk()
        coVerify(exactly = 1) { repo.createKinfolkComplete(any()) }
        assertTrue(vm.addKinfolkState.value.isSuccess)
    }

    /**
     * The retry runs against an ALREADY-CREATED household, so the operator
     * can still edit the contact fields on it. web's Fix round 1 (#829) found
     * this exact gap: skip re-validation and a cleared or household-matching
     * retry comes back as a callable-failure message instead of the plain
     * spec refusal, and never even reaches the second createKinfolkComplete
     * call it would otherwise have to avoid.
     */
    @Test
    fun `a retry with a cleared contact is refused before it ever calls the callable again`() {
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(firstArg<Kinfolk>().copy(id = "kf-new")) }
        coEvery { repo.saveEmergencyContacts("kf-new", any()) } returns Result.failure(Exception("offline"))
        vm.updateFirstName("Jamie")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125559090"))
        vm.saveKinfolk()
        assertEquals("kf-new", vm.addKinfolkState.value.createdKinfolkId)

        vm.updateAddEmergencyContact(0, EmergencyContactDraft())
        vm.saveKinfolk()

        assertEquals(EMERGENCY_CONTACT_REQUIRED, vm.addKinfolkState.value.error)
        assertEquals("kf-new", vm.addKinfolkState.value.createdKinfolkId)
        coVerify(exactly = 1) { repo.createKinfolkComplete(any()) }
        coVerify(exactly = 1) { repo.saveEmergencyContacts(any(), any()) }
    }

    /**
     * The household already exists once `createdKinfolkId` is set; only the
     * Emergency Contact should still be editable. Before the fix, every
     * household updater kept writing state.value regardless, so an edit made
     * during the retry was silently dropped on success (the form resets to
     * `AddKinfolkUiState(isSuccess = true)`, never carrying it to the server)
     * and the "outside the household" check compared the contact against
     * whatever was typed just now rather than what was actually saved.
     */
    @Test
    fun `household fields ignore updates once the household is created, so a retry cannot silently change what was saved`() {
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(firstArg<Kinfolk>().copy(id = "kf-new")) }
        coEvery { repo.saveEmergencyContacts("kf-new", any()) } returnsMany listOf(Result.failure(Exception("offline")), Result.success(emptyList()))
        vm.updateFirstName("Jamie")
        vm.updatePhoneNumber("5125551234")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Halbrook", "5125559090"))
        vm.saveKinfolk()
        assertEquals("kf-new", vm.addKinfolkState.value.createdKinfolkId)

        vm.updateFirstName("Someone Else")
        vm.updateLastName("Someone Else")
        vm.updatePhoneNumber("0000000000")
        vm.updateServiceAddress("A different address")
        vm.updateAddStatus("active")

        val locked = vm.addKinfolkState.value
        assertEquals("Jamie", locked.firstName)
        assertEquals("", locked.lastName)
        assertEquals("5125551234", locked.phoneNumber)
        assertEquals("", locked.serviceAddress)
        assertEquals("prospect", locked.status)

        vm.saveKinfolk()
        coVerify { repo.saveEmergencyContacts("kf-new", listOf(EmergencyContactDraft("Rae Halbrook", "5125559090"))) }
        assertTrue(vm.addKinfolkState.value.isSuccess)
    }

    @Test
    fun `edit with no other change still saves a changed contact list, and never puts it in the diff`() {
        val stored = Kinfolk(id = "kf1", firstName = "Jamie", phoneNumber = "5125551234", emergencyContactName = "Rae", emergencyContactPhone = "5125559090")
        coEvery { repo.getKinfolk() } returns Result.success(listOf(stored))
        coEvery { repo.saveEmergencyContacts("kf1", any()) } returns Result.success(emptyList())
        vm.loadKinfolkForEdit("kf1")
        vm.addEditEmergencyContact()
        vm.updateEditEmergencyContact(1, EmergencyContactDraft("Lee Park", "5125550177"))
        vm.saveKinfolkChanges()
        coVerify(exactly = 0) { repo.updateKinfolkFields(any(), any()) }
        coVerify { repo.saveEmergencyContacts("kf1", listOf(EmergencyContactDraft("Rae", "5125559090"), EmergencyContactDraft("Lee Park", "5125550177"))) }
    }

    @Test
    fun `a household with none saves unrelated edits without being asked for one`() {
        val stored = Kinfolk(id = "kf1", firstName = "Jamie", phoneNumber = "5125551234")
        coEvery { repo.getKinfolk() } returns Result.success(listOf(stored))
        coEvery { repo.updateKinfolkFields("kf1", any()) } returns Result.success(Unit)
        vm.loadKinfolkForEdit("kf1")
        vm.updateEditFirstName("Jamey")
        vm.saveKinfolkChanges()
        coVerify { repo.updateKinfolkFields("kf1", mapOf("firstName" to "Jamey")) }
        coVerify(exactly = 0) { repo.saveEmergencyContacts(any(), any()) }
        assertFalse(vm.editKinfolkState.value.error != null)
    }
}
