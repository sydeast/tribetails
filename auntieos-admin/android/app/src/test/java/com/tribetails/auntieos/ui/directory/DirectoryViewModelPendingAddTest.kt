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
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = id), duplicateOf)) }
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
        coVerify(exactly = 1) { repo.createKinfolkComplete(any()) }
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

    @Test
    fun `a duplicateOf answer saves the contact onto that household and logs no second CREATE`() {
        coEvery { repo.createKinfolkComplete(any()) } answers { Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = "kf-existing"), "kf-existing")) }
        coEvery { repo.saveEmergencyContacts("kf-existing", any()) } returns Result.success(emptyList())
        vm.updateFirstName("Jamie")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))

        vm.saveKinfolk()

        assertTrue(vm.addKinfolkState.value.isSuccess)
        coVerify(exactly = 1) { repo.saveEmergencyContacts("kf-existing", any()) }
        coVerify(exactly = 0) { repo.logActivity(match { it.actionType == "CREATE_KINFOLK" }) }
    }

    @Test
    fun `a duplicateOf answer whose contact fails logs no CREATE either, and still keeps the household`() {
        addWithFailedContact(id = "kf-existing", duplicateOf = "kf-existing")

        assertEquals("kf-existing", vm.addKinfolkState.value.createdKinfolkId)
        coVerify(exactly = 0) { repo.logActivity(match { it.actionType == "CREATE_KINFOLK" }) }
    }

    @Test
    fun `a new household still logs its CREATE`() {
        addWithFailedContact()
        coVerify(exactly = 1) { repo.logActivity(match { it.actionType == "CREATE_KINFOLK" && it.targetId == "kf-890" }) }
    }
}
