package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Operator ruling (issue #13, 2026-07-25): the vet field's value is ALWAYS a
 * clinic from the curated catalog, on Android exactly as on web. These pin the
 * ViewModel half of that: selecting and creating stamp `vetClinicId` with the
 * denormalized name/phone/address beside it, clearing empties all four, and a
 * legacy string-only household still loads and saves untouched.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelVetPickerTest {

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    private val riverside = VetClinic(
        id = "riverside",
        name = "Riverside Animal Hospital",
        phone = "(512) 555-0100",
        address = "1 Mill St",
    )
    private val petEr = VetClinic(
        id = "er1",
        name = "Austin Pet ER",
        phone = "(512) 555-0300",
        address = "4 Night Ln",
        isEmergency = true,
    )

    /** A household saved before the picker existed: vet strings, no id. */
    private val legacyHousehold = Kinfolk(
        id = "kf-legacy",
        firstName = "Sandy",
        lastName = "Thorne",
        phoneNumber = "555-100-2000",
        status = "active",
        vetClinicName = "Old Corner Vet",
        vetClinicPhone = "after hours: 512-555-0000",
        vetClinicAddress = "behind the feed store",
    )

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getKinfolk() } returns Result.success(listOf(legacyHousehold))
        coEvery { repository.getAllKin() } returns Result.success(emptyList<Kin>())
        coEvery { repository.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repository.observeVetClinics() } returns flowOf(listOf(riverside, petEr))
        coEvery { repository.submitVetClinic(any()) } returns Result.success("new-clinic")
        viewModel = DirectoryViewModel(repository, invoiceRepository)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    // ── selecting ────────────────────────────────────────────────────────────

    @Test
    fun `selecting a clinic stamps the id alongside the denormalized fields`() = runTest(testDispatcher) {
        viewModel.selectVetClinic(riverside)
        val s = viewModel.editKinfolkState.value
        assertEquals("riverside", s.vetClinicId)
        assertEquals("Riverside Animal Hospital", s.vetClinicName)
        assertEquals("(512) 555-0100", s.vetClinicPhone)
        assertEquals("1 Mill St", s.vetClinicAddress)
    }

    @Test
    fun `selecting an emergency clinic writes only the emergency four`() = runTest(testDispatcher) {
        viewModel.selectEmergencyVetClinic(petEr)
        val s = viewModel.editKinfolkState.value
        assertEquals("er1", s.emergencyVetClinicId)
        assertEquals("Austin Pet ER", s.emergencyVetClinicName)
        assertEquals("(512) 555-0300", s.emergencyVetClinicPhone)
        assertEquals("4 Night Ln", s.emergencyVetClinicAddress)
        // The day clinic is untouched.
        assertEquals("", s.vetClinicId)
        assertEquals("", s.vetClinicName)
    }

    // ── clearing ─────────────────────────────────────────────────────────────

    @Test
    fun `clearing empties the id AND the denormalized fields, leaving no half-record`() =
        runTest(testDispatcher) {
            viewModel.selectVetClinic(riverside)
            viewModel.clearVetClinic()
            val s = viewModel.editKinfolkState.value
            assertEquals("", s.vetClinicId)
            assertEquals("", s.vetClinicName)
            assertEquals("", s.vetClinicPhone)
            assertEquals("", s.vetClinicAddress)
        }

    @Test
    fun `clearing the emergency vet leaves the day clinic alone`() = runTest(testDispatcher) {
        viewModel.selectVetClinic(riverside)
        viewModel.selectEmergencyVetClinic(petEr)
        viewModel.clearEmergencyVetClinic()
        val s = viewModel.editKinfolkState.value
        assertEquals("", s.emergencyVetClinicId)
        assertEquals("", s.emergencyVetClinicName)
        assertEquals("riverside", s.vetClinicId)
    }

    // ── creating ─────────────────────────────────────────────────────────────

    @Test
    fun `creating submits the clinic and selects it with the returned id`() = runTest(testDispatcher) {
        viewModel.createVetClinicFromSearch(
            name = "  Barton Springs Animal Clinic  ",
            phone = "(512) 555-0400",
            address = "2 Barton Rd",
        )
        advanceUntilIdle()

        coVerify {
            repository.submitVetClinic(
                match {
                    it.name == "Barton Springs Animal Clinic" &&
                        it.phone == "(512) 555-0400" &&
                        it.address == "2 Barton Rd" &&
                        !it.isEmergency
                }
            )
        }
        val s = viewModel.editKinfolkState.value
        assertEquals("new-clinic", s.vetClinicId)
        assertEquals("Barton Springs Animal Clinic", s.vetClinicName)
        assertEquals("(512) 555-0400", s.vetClinicPhone)
    }

    @Test
    fun `creating for the emergency slot flags the clinic and fills the emergency four`() =
        runTest(testDispatcher) {
            viewModel.createVetClinicFromSearch(
                name = "Night Owl Pet ER",
                isEmergency = true,
                forEmergencySlot = true,
            )
            advanceUntilIdle()

            coVerify { repository.submitVetClinic(match { it.isEmergency }) }
            val s = viewModel.editKinfolkState.value
            assertEquals("new-clinic", s.emergencyVetClinicId)
            assertEquals("Night Owl Pet ER", s.emergencyVetClinicName)
            assertEquals("", s.vetClinicId)
        }

    /**
     * The backend dedupes on a normalized name and hands back the EXISTING id.
     * When that id is already in the catalog, its stored details win over what
     * was just retyped: the bank's copy is the curated one, and overwriting a
     * good phone number from a hurried retype is the failure mode here.
     */
    @Test
    fun `a dedupe hit selects the CATALOG copy, not the hastily retyped one`() = runTest(testDispatcher) {
        coEvery { repository.submitVetClinic(any()) } returns Result.success("riverside")
        // vetClinicsFlow is WhileSubscribed, so it only holds a value while a
        // collector is attached. The edit screen is that collector in production
        // (it renders the picker from this very flow), and the create control
        // only exists while that screen is on top, so subscribing here models
        // the real conditions rather than papering over them.
        backgroundScope.launch { viewModel.vetClinicsFlow.collect {} }
        advanceUntilIdle()

        viewModel.createVetClinicFromSearch(name = "riverside animal hospital", phone = "")
        advanceUntilIdle()

        val s = viewModel.editKinfolkState.value
        assertEquals("riverside", s.vetClinicId)
        assertEquals("Riverside Animal Hospital", s.vetClinicName)
        assertEquals("(512) 555-0100", s.vetClinicPhone)
        assertEquals("1 Mill St", s.vetClinicAddress)
    }

    @Test
    fun `a failed create selects nothing rather than a clinic that was never written`() =
        runTest(testDispatcher) {
            coEvery { repository.submitVetClinic(any()) } returns Result.failure(Exception("permission-denied"))
            viewModel.createVetClinicFromSearch(name = "Barton Springs")
            advanceUntilIdle()

            val s = viewModel.editKinfolkState.value
            assertEquals("", s.vetClinicId)
            assertEquals("", s.vetClinicName)
        }

    @Test
    fun `a blank name never reaches the callable`() = runTest(testDispatcher) {
        viewModel.createVetClinicFromSearch(name = "   ")
        advanceUntilIdle()
        coVerify(exactly = 0) { repository.submitVetClinic(any()) }
    }

    // ── legacy string-only households ────────────────────────────────────────

    @Test
    fun `a legacy household loads its vet strings with an EMPTY id, not a fabricated one`() =
        runTest(testDispatcher) {
            advanceUntilIdle()
            viewModel.loadKinfolkForEdit("kf-legacy")
            advanceUntilIdle()

            val s = viewModel.editKinfolkState.value
            assertEquals("", s.vetClinicId)
            assertEquals("Old Corner Vet", s.vetClinicName)
            assertEquals("after hours: 512-555-0000", s.vetClinicPhone)
            assertEquals("behind the feed store", s.vetClinicAddress)
        }

    /**
     * The trap this must not spring: an operator opening a legacy record to fix
     * a phone number must be able to save WITHOUT touching the vet field, and
     * the stored vet must come back out exactly as it went in.
     */
    @Test
    fun `a legacy household saves untouched, vet strings intact and id still empty`() =
        runTest(testDispatcher) {
            coEvery { repository.updateKinfolk(any()) } returns Result.success(Unit)
            advanceUntilIdle()
            viewModel.loadKinfolkForEdit("kf-legacy")
            advanceUntilIdle()

            viewModel.updateEditPhoneNumber("555-999-1111")
            viewModel.saveKinfolkChanges()
            advanceUntilIdle()

            coVerify {
                repository.updateKinfolk(
                    match {
                        it.vetClinicId == "" &&
                            it.vetClinicName == "Old Corner Vet" &&
                            it.vetClinicPhone == "after hours: 512-555-0000" &&
                            it.vetClinicAddress == "behind the feed store" &&
                            it.phoneNumber == "555-999-1111"
                    }
                )
            }
        }

    @Test
    fun `a legacy vet can be replaced with a real catalog pick`() = runTest(testDispatcher) {
        advanceUntilIdle()
        viewModel.loadKinfolkForEdit("kf-legacy")
        advanceUntilIdle()
        assertTrue(viewModel.editKinfolkState.value.vetClinicId.isEmpty())

        viewModel.clearVetClinic()
        viewModel.selectVetClinic(riverside)

        val s = viewModel.editKinfolkState.value
        assertEquals("riverside", s.vetClinicId)
        assertEquals("Riverside Animal Hospital", s.vetClinicName)
    }
}
