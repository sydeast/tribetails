package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.SubmitVetClinicResult
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.model.VetClinicsSnapshot
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    private val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
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
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repository.observeVetClinicsOrFail() } returns
            flowOf(VetClinicsSnapshot(clinics = listOf(riverside, petEr)))
        coEvery { repository.submitVetClinicDetailed(any()) } returns
            Result.success(SubmitVetClinicResult(clinicId = "new-clinic", created = true, pending = false))
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
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
            repository.submitVetClinicDetailed(
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
        // A genuine create (not a dedupe hit): nothing to disclose.
        assertNull(viewModel.vetClinicDedupeNote.value)
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

            coVerify { repository.submitVetClinicDetailed(match { it.isEmergency }) }
            val s = viewModel.editKinfolkState.value
            assertEquals("new-clinic", s.emergencyVetClinicId)
            assertEquals("Night Owl Pet ER", s.emergencyVetClinicName)
            assertEquals("", s.vetClinicId)
            assertNull(viewModel.emergencyVetClinicDedupeNote.value)
        }

    /**
     * The backend dedupes on a normalized name and hands back the EXISTING id.
     * When that id is already in the catalog, its stored details win over what
     * was just retyped: the bank's copy is the curated one, and overwriting a
     * good phone number from a hurried retype is the failure mode here.
     */
    @Test
    fun `a dedupe hit selects the CATALOG copy, not the hastily retyped one`() = runTest(testDispatcher) {
        coEvery { repository.submitVetClinicDetailed(any()) } returns
            Result.success(SubmitVetClinicResult(clinicId = "riverside", created = false, pending = false))
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

    /**
     * A dedupe hit is not an error and must not be silent: the operator asked
     * to CREATE a clinic and got an EXISTING one selected instead. Mirrors web
     * VetClinicPicker's `dedupedName` note, which exists for the same reason
     * (see its own comment: "the difference between that reading as 'it
     * worked' and as 'nothing happened'").
     */
    @Test
    fun `a dedupe hit discloses which clinic the household was linked to instead`() =
        runTest(testDispatcher) {
            coEvery { repository.submitVetClinicDetailed(any()) } returns
                Result.success(SubmitVetClinicResult(clinicId = "riverside", created = false, pending = false))
            backgroundScope.launch { viewModel.vetClinicsFlow.collect {} }
            advanceUntilIdle()

            viewModel.createVetClinicFromSearch(name = "riverside animal hospital", phone = "")
            advanceUntilIdle()

            assertEquals(
                "Riverside Animal Hospital was already in the catalog, so this household is linked to " +
                    "that record instead of a duplicate.",
                viewModel.vetClinicDedupeNote.value,
            )
            // The OTHER picker is untouched by a day-vet dedupe.
            assertNull(viewModel.emergencyVetClinicDedupeNote.value)
        }

    @Test
    fun `an emergency dedupe hit discloses on the emergency note, not the day one`() =
        runTest(testDispatcher) {
            coEvery { repository.submitVetClinicDetailed(any()) } returns
                Result.success(SubmitVetClinicResult(clinicId = "er1", created = false, pending = false))
            backgroundScope.launch { viewModel.vetClinicsFlow.collect {} }
            advanceUntilIdle()

            viewModel.createVetClinicFromSearch(name = "austin pet er", isEmergency = true, forEmergencySlot = true)
            advanceUntilIdle()

            assertEquals(
                "Austin Pet ER was already in the catalog, so this household is linked to that record " +
                    "instead of a duplicate.",
                viewModel.emergencyVetClinicDedupeNote.value,
            )
            assertNull(viewModel.vetClinicDedupeNote.value)
        }

    @Test
    fun `a genuine create clears any stale dedupe note from an earlier attempt`() =
        runTest(testDispatcher) {
            coEvery { repository.submitVetClinicDetailed(any()) } returns
                Result.success(SubmitVetClinicResult(clinicId = "riverside", created = false, pending = false))
            backgroundScope.launch { viewModel.vetClinicsFlow.collect {} }
            advanceUntilIdle()
            viewModel.createVetClinicFromSearch(name = "riverside animal hospital")
            advanceUntilIdle()
            assertTrue(viewModel.vetClinicDedupeNote.value != null)

            coEvery { repository.submitVetClinicDetailed(any()) } returns
                Result.success(SubmitVetClinicResult(clinicId = "new-clinic", created = true, pending = false))
            viewModel.createVetClinicFromSearch(name = "Barton Springs Animal Clinic")
            advanceUntilIdle()

            assertNull(viewModel.vetClinicDedupeNote.value)
        }

    @Test
    fun `selecting a clinic directly clears a stale dedupe note`() = runTest(testDispatcher) {
        coEvery { repository.submitVetClinicDetailed(any()) } returns
            Result.success(SubmitVetClinicResult(clinicId = "riverside", created = false, pending = false))
        backgroundScope.launch { viewModel.vetClinicsFlow.collect {} }
        advanceUntilIdle()
        viewModel.createVetClinicFromSearch(name = "riverside animal hospital")
        advanceUntilIdle()
        assertTrue(viewModel.vetClinicDedupeNote.value != null)

        viewModel.selectVetClinic(petEr)
        assertNull(viewModel.vetClinicDedupeNote.value)
    }

    @Test
    fun `clearing the vet clinic clears a stale dedupe note`() = runTest(testDispatcher) {
        coEvery { repository.submitVetClinicDetailed(any()) } returns
            Result.success(SubmitVetClinicResult(clinicId = "riverside", created = false, pending = false))
        backgroundScope.launch { viewModel.vetClinicsFlow.collect {} }
        advanceUntilIdle()
        viewModel.createVetClinicFromSearch(name = "riverside animal hospital")
        advanceUntilIdle()
        assertTrue(viewModel.vetClinicDedupeNote.value != null)

        viewModel.clearVetClinic()
        assertNull(viewModel.vetClinicDedupeNote.value)
    }

    @Test
    fun `a failed create selects nothing rather than a clinic that was never written`() =
        runTest(testDispatcher) {
            coEvery { repository.submitVetClinicDetailed(any()) } returns
                Result.failure(Exception("permission-denied"))
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
        coVerify(exactly = 0) { repository.submitVetClinicDetailed(any()) }
    }

    // ── catalog load failure (AuntieRepository.observeVetClinicsOrFail) ──────

    /**
     * The regression this pins: observeVetClinics (still used by
     * VetClinicsViewModel) collapses a load error into emptyList(), which is
     * indistinguishable from a genuinely empty catalog. The Kinfolk edit
     * screen's picker has a household vet field that read could silently look
     * unset because of; observeVetClinicsOrFail is what keeps the two apart.
     */
    @Test
    fun `a catalog load failure is disclosed via vetClinicsLoadFailed`() = runTest(testDispatcher) {
        coEvery { repository.observeVetClinicsOrFail() } returns flowOf(VetClinicsSnapshot(failed = true))
        val vm = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
        backgroundScope.launch { vm.vetClinicsFlow.collect {} }
        backgroundScope.launch { vm.vetClinicsLoadFailed.collect {} }
        advanceUntilIdle()

        assertTrue(vm.vetClinicsLoadFailed.value)
        assertEquals(emptyList<VetClinic>(), vm.vetClinicsFlow.value)
    }

    @Test
    fun `a successful catalog load carries no failure`() = runTest(testDispatcher) {
        backgroundScope.launch { viewModel.vetClinicsFlow.collect {} }
        backgroundScope.launch { viewModel.vetClinicsLoadFailed.collect {} }
        advanceUntilIdle()

        assertFalse(viewModel.vetClinicsLoadFailed.value)
        assertEquals(listOf(riverside, petEr), viewModel.vetClinicsFlow.value)
    }

    /**
     * A picker mid-edit should not go blank because of a transient blip: the
     * household's own vet fields did not come from this read (mirrors web's
     * comment on the same point in KinfolkEdit.tsx), so a failure keeps
     * whatever clinic list was last good rather than clearing it.
     */
    @Test
    fun `a failure after a good load keeps the last good clinic list`() = runTest(testDispatcher) {
        coEvery { repository.observeVetClinicsOrFail() } returns
            flowOf(VetClinicsSnapshot(clinics = listOf(riverside, petEr)), VetClinicsSnapshot(failed = true))
        val vm = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
        backgroundScope.launch { vm.vetClinicsFlow.collect {} }
        backgroundScope.launch { vm.vetClinicsLoadFailed.collect {} }
        advanceUntilIdle()

        assertTrue(vm.vetClinicsLoadFailed.value)
        assertEquals(listOf(riverside, petEr), vm.vetClinicsFlow.value)
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
