package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.EmergencyContactDraft
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.KinfolkCreated
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1951: Add Kinfolk saved a household with letters for its phone and an email
 * with no @ sign. Each field now says so beside itself, and nothing is created
 * until every phone and email is one.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AddKinfolkChecksTest {

    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
    private lateinit var vm: DirectoryViewModel

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repo.createKinfolkComplete(any(), any()) } answers {
            Result.success(KinfolkCreated(firstArg<Kinfolk>().copy(id = "kf-new"), null))
        }
        coEvery { repo.saveEmergencyContacts(any(), any()) } returns Result.success(emptyList())
        vm = DirectoryViewModel(repo, mockk<InvoiceRepository>(relaxed = true), kinCareRepo)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `each field names its own problem, and a blank one has none`() {
        assertEquals(ADD_KINFOLK_PHONE_INVALID, addKinfolkPhoneError("abc"))
        assertEquals(ADD_KINFOLK_PHONE_INVALID, addKinfolkPhoneError("555-0134"))
        assertNull(addKinfolkPhoneError("(805) 555-0134"))
        assertNull(addKinfolkPhoneError("1 805 555 0134"))
        assertNull(addKinfolkPhoneError(""))
        assertEquals(ADD_KINFOLK_SECONDARY_PHONE_INVALID, addKinfolkSecondaryPhoneError("xyz"))
        assertNull(addKinfolkSecondaryPhoneError("  "))
        assertEquals(ADD_KINFOLK_EMAIL_INVALID, addKinfolkEmailError("catch"))
        assertEquals(ADD_KINFOLK_EMAIL_INVALID, addKinfolkEmailError("catch@hanasamku"))
        assertNull(addKinfolkEmailError("catch@hanasamku.com"))
        assertNull(addKinfolkEmailError(""))
        assertEquals(EMERGENCY_CONTACT_PHONE_SHAPE, emergencyContactPhoneShapeError(listOf(EmergencyContactDraft("Rae Park", "xyz"))))
        assertNull(emergencyContactPhoneShapeError(listOf(EmergencyContactDraft("Rae Park", "8055550199"))))
        assertNull(emergencyContactPhoneShapeError(listOf(EmergencyContactDraft("Rae Park", ""))))
    }

    @Test
    fun `letters for a phone create nothing`() {
        vm.updateFirstName("Jamie")
        vm.updatePhoneNumber("abc")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()
        assertEquals(ADD_KINFOLK_PHONE_INVALID, vm.addKinfolkState.value.error)
        coVerify(exactly = 0) { repo.createKinfolkComplete(any(), any()) }
    }

    @Test
    fun `an email with no at sign creates nothing`() {
        vm.updateFirstName("Jamie")
        vm.updatePhoneNumber("(805) 555-0134")
        vm.updateEmail("catch")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()
        assertEquals(ADD_KINFOLK_EMAIL_INVALID, vm.addKinfolkState.value.error)
        coVerify(exactly = 0) { repo.createKinfolkComplete(any(), any()) }
    }

    @Test
    fun `letters for the Emergency Contact phone create nothing`() {
        vm.updateFirstName("Jamie")
        vm.updateEmail("pawsome@hanasamku.com")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "xyz"))
        vm.saveKinfolk()
        assertEquals(EMERGENCY_CONTACT_PHONE_SHAPE, vm.addKinfolkState.value.error)
        coVerify(exactly = 0) { repo.createKinfolkComplete(any(), any()) }
    }

    @Test
    fun `a form that passes is created`() {
        vm.updateFirstName("Jamie")
        vm.updatePhoneNumber("(805) 555-0134")
        vm.updateEmail("pawsome@hanasamku.com")
        vm.updateAddEmergencyContact(0, EmergencyContactDraft("Rae Park", "8055550199"))
        vm.saveKinfolk()
        coVerify(exactly = 1) { repo.createKinfolkComplete(any(), any()) }
        assertTrue(vm.addKinfolkState.value.isSuccess)
    }
}
