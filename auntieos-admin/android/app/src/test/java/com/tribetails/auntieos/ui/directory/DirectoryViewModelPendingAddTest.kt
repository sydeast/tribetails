package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.KinfolkCreated
import io.mockk.Called
import io.mockk.clearMocks
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #890 on admin Android: a household Add created whose Emergency Contact did not
 * save is offered back when Add opens again, with the same Continue or Discard
 * choice admin web and the desktop console give. And a `duplicateOf` answer from
 * `createKinfolk` is a household created minutes ago, so no second CREATE audit.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelPendingAddTest {

    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
    private lateinit var vm: DirectoryViewModel

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        vm = DirectoryViewModel(repo, mockk<InvoiceRepository>(relaxed = true), kinCareRepo)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun addWithFailedContact(id: String = "kf-890", duplicateOf: String? = null) {
        coEvery { repo.createKinfolkComplete(any(), any()) } answers { Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = id), duplicateOf)) }
        coEvery { repo.saveEmergencyContacts(id, any()) } returns Result.failure(Exception("offline"))
        vm.updateFirstName("Jamie")
        vm.updateLastName("Halbrook")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()
    }

    @Test
    fun `leaving Add with a household waiting on its contact offers it back, named`() {
        addWithFailedContact()
        assertFalse("no prompt while Add is still open", vm.addKinfolkState.value.offerPendingOnOpen)

        vm.leaveAddKinfolk()

        val s = vm.addKinfolkState.value
        assertTrue(s.offerPendingOnOpen)
        assertEquals("kf-890", s.createdKinfolkId)
        assertEquals("Jamie Halbrook", pendingHouseholdName(s))
    }

    @Test
    fun `leaving Add with only a draft offers nothing`() {
        vm.updateFirstName("Jamie")
        vm.leaveAddKinfolk()
        assertFalse(vm.addKinfolkState.value.offerPendingOnOpen)
        assertNull(vm.addKinfolkState.value.createdKinfolkId)
    }

    @Test
    fun `Continue returns to that household, and saving its contact never creates a second one`() {
        addWithFailedContact()
        vm.leaveAddKinfolk()

        vm.continuePendingAdd()
        assertFalse(vm.addKinfolkState.value.offerPendingOnOpen)
        assertEquals("kf-890", vm.addKinfolkState.value.createdKinfolkId)
        assertEquals("Rae Park", vm.addKinfolkState.value.emergencyContacts.single().name)

        coEvery { repo.saveEmergencyContacts("kf-890", any()) } returns Result.success(emptyList())
        vm.saveKinfolk()

        assertTrue(vm.addKinfolkState.value.isSuccess)
        coVerify(exactly = 1) { repo.createKinfolkComplete(any(), any()) }
        coVerify(exactly = 2) { repo.saveEmergencyContacts("kf-890", any()) }
    }

    @Test
    fun `Discard starts a blank Add and writes nothing, so the household keeps its No Emergency Contact flag`() {
        addWithFailedContact()
        vm.leaveAddKinfolk()
        clearMocks(repo, answers = false, recordedCalls = true, childMocks = false, verificationMarks = true, exclusionRules = false)

        vm.discardPendingAdd()

        verify { repo wasNot Called }
        val s = vm.addKinfolkState.value
        assertFalse(s.offerPendingOnOpen)
        assertNull(s.createdKinfolkId)
        assertEquals("", s.firstName)
        // Nothing left to offer next time.
        vm.leaveAddKinfolk()
        assertFalse(vm.addKinfolkState.value.offerPendingOnOpen)
    }

    /** #907 review item 1(b): a duplicate is never a success and never has the contact saved onto it. */
    @Test
    fun `a duplicateOf answer is not a success, saves no contact, logs no CREATE, and hands the typing on`() {
        addDuplicate()

        val s = vm.addKinfolkState.value
        assertFalse("a duplicateOf answer was reported as saved", s.isSuccess)
        assertEquals("kf-existing", s.duplicateOf)
        assertNull(s.createdKinfolkId)
        coVerify(exactly = 0) { repo.saveEmergencyContacts(any(), any()) }
        coVerify(exactly = 0) { repo.logActivity(match { it.actionType == "CREATE_KINFOLK" }) }
    }

    private fun addDuplicate() {
        coEvery { repo.createKinfolkComplete(any(), any()) } answers { Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = "kf-existing"), "kf-existing")) }
        vm.updateFirstName("Jamie")
        vm.updateLastName("Halbrook-Park")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()
    }

    /** #907 review item 1(b), the edit screen side. */
    @Test
    fun `the household's edit form opens with what Add typed that differs, unsaved, and saves only that`() {
        addDuplicate()
        coEvery { repo.getKinfolk() } returns Result.success(
            listOf(Kinfolk(id = "kf-existing", firstName = "Jamie", lastName = "Halbrook", phoneNumber = "8055550134", status = "prospect", preferredContactMethod = "Text")),
        )
        coEvery { repo.updateKinfolkFields(any(), any()) } returns Result.success(Unit)
        coEvery { repo.saveEmergencyContacts("kf-existing", any()) } returns Result.success(emptyList())

        vm.loadKinfolkForEdit("kf-existing")

        val e = vm.editKinfolkState.value
        assertEquals("Halbrook-Park", e.lastName)
        // A blank typed phone is "not typed", never "clear it".
        assertEquals("8055550134", e.phoneNumber)
        assertEquals("Rae Park", e.emergencyContacts.single().name)
        assertEquals(
            "Jamie Halbrook was already added a few minutes ago. What you typed in Add that differs is filled in below and is not saved yet.",
            e.duplicateAddNotice,
        )
        assertTrue(vm.editHasUnsavedChanges())

        vm.saveKinfolkChanges()

        coVerify(exactly = 1) { repo.updateKinfolkFields("kf-existing", match { it.keys == setOf("lastName") }) }
        coVerify(exactly = 1) { repo.saveEmergencyContacts("kf-existing", any()) }

        // Opened again, it is only the stored household: the typing was used once.
        vm.loadKinfolkForEdit("kf-existing")
        assertNull(vm.editKinfolkState.value.duplicateAddNotice)
    }

    /** #907 review item 1(a): Discard says the next Add is a new household. */
    @Test
    fun `after Discard the next create names the discarded household, once`() {
        addWithFailedContact()
        vm.leaveAddKinfolk()
        vm.discardPendingAdd()
        assertEquals("kf-890", vm.addKinfolkState.value.discardedKinfolkId)

        coEvery { repo.createKinfolkComplete(any(), any()) } answers { Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = "kf-new"), null)) }
        coEvery { repo.saveEmergencyContacts("kf-new", any()) } returns Result.success(emptyList())
        vm.updateFirstName("Jamie")
        vm.updateLastName("Halbrook")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()

        assertTrue(vm.addKinfolkState.value.isSuccess)
        coVerify(exactly = 1) { repo.createKinfolkComplete(any(), "kf-890") }
        assertNull(vm.addKinfolkState.value.discardedKinfolkId)
    }

    /** #907 review item 2. */
    @Test
    fun `a household deleted while its contact was pending is dropped with That household no longer exists`() {
        addWithFailedContact()
        coEvery { repo.saveEmergencyContacts("kf-890", any()) } returns Result.failure(Exception(HOUSEHOLD_NO_LONGER_EXISTS))

        vm.saveKinfolk()

        val s = vm.addKinfolkState.value
        assertNull(s.createdKinfolkId)
        assertEquals(HOUSEHOLD_NO_LONGER_EXISTS, s.error)
        vm.leaveAddKinfolk()
        assertFalse("a household that is gone was offered again", vm.addKinfolkState.value.offerPendingOnOpen)
    }

    /** #907 review item 3. */
    @Test
    fun `a different operator never sees the last operator's pending Add`() {
        vm.operatorChanged("op-1")
        addWithFailedContact()
        vm.leaveAddKinfolk()

        vm.operatorChanged("op-1")
        assertEquals("kf-890", vm.addKinfolkState.value.createdKinfolkId)

        vm.operatorChanged(null)
        assertNull(vm.addKinfolkState.value.createdKinfolkId)
        assertFalse(vm.addKinfolkState.value.offerPendingOnOpen)
    }

    @Test
    fun `a new household still logs its CREATE`() {
        addWithFailedContact()
        coVerify(exactly = 1) { repo.logActivity(match { it.actionType == "CREATE_KINFOLK" && it.targetId == "kf-890" }) }
    }
}
