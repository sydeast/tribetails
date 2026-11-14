package com.tribetails.auntieos.ui.directory

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #2161, operator ruling 2026-11-13: only the owner archives or restores a
 * Kinfolk household. The server enforces it; these pin the Android half: who
 * is offered the control, that the status picker cannot archive or restore,
 * and the plain sentence a refusal shows.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinfolkArchiveOwnerOnlyTest {

    // ── who counts as the owner ────────────────────────────────────────────

    @Test
    fun `the admin claim alone is the owner`() {
        assertTrue(isOwnerFromClaims(mapOf("admin" to true)))
    }

    @Test
    fun `an Auntie is not the owner`() {
        assertFalse(isOwnerFromClaims(mapOf("staffRole" to "auntie")))
    }

    @Test
    fun `an account carrying both claims is not the owner`() {
        assertFalse(isOwnerFromClaims(mapOf("admin" to true, "staffRole" to "auntie")))
    }

    @Test
    fun `no claims, a household claim, or a sandbox claim is not the owner`() {
        assertFalse(isOwnerFromClaims(emptyMap()))
        assertFalse(isOwnerFromClaims(mapOf("role" to "kinfolk", "kinfolkId" to "kf1")))
        assertFalse(isOwnerFromClaims(mapOf("testTribeId" to "sandbox")))
        assertFalse(isOwnerFromClaims(mapOf("admin" to "true")))
    }

    // ── which control the editor shows ─────────────────────────────────────

    @Test
    fun `the owner sees Archive on an active household and Restore on an archived one`() {
        assertEquals(KinfolkArchiveControl.ARCHIVE, kinfolkArchiveControlFor(true, "active"))
        assertEquals(KinfolkArchiveControl.ARCHIVE, kinfolkArchiveControlFor(true, "prospect"))
        assertEquals(KinfolkArchiveControl.RESTORE, kinfolkArchiveControlFor(true, "archived"))
        assertEquals(KinfolkArchiveControl.RESTORE, kinfolkArchiveControlFor(true, "Archived"))
    }

    @Test
    fun `an Auntie sees neither control`() {
        assertEquals(KinfolkArchiveControl.NONE, kinfolkArchiveControlFor(false, "active"))
        assertEquals(KinfolkArchiveControl.NONE, kinfolkArchiveControlFor(false, "archived"))
    }

    @Test
    fun `nothing shows while the owner check is still running`() {
        assertEquals(KinfolkArchiveControl.NONE, kinfolkArchiveControlFor(null, "active"))
        assertEquals(KinfolkArchiveControl.NONE, kinfolkArchiveControlFor(null, "archived"))
    }

    @Test
    fun `archived is not a status chip`() {
        assertEquals(listOf("active", "prospect", "inactive"), KINFOLK_PICKABLE_STATUSES)
    }

    // ── the refusal ────────────────────────────────────────────────────────

    @Test
    fun `a server refusal reads as the owner-only sentence`() {
        val denied = mockk<FirebaseFunctionsException>()
        every { denied.code } returns FirebaseFunctionsException.Code.PERMISSION_DENIED
        every { denied.message } returns "Admin claim required."
        assertEquals(KINFOLK_ARCHIVE_OWNER_ONLY, kinfolkArchiveErrorText(denied, "Failed"))
        assertEquals("Only the owner can archive or restore a Kinfolk household.", KINFOLK_ARCHIVE_OWNER_ONLY)
    }

    @Test
    fun `any other failure keeps its own words, or the fallback`() {
        val offline = mockk<FirebaseFunctionsException>()
        every { offline.code } returns FirebaseFunctionsException.Code.UNAVAILABLE
        every { offline.message } returns "The server could not be reached."
        assertEquals("The server could not be reached.", kinfolkArchiveErrorText(offline, "Failed"))
        assertEquals("Failed", kinfolkArchiveErrorText(RuntimeException(""), "Failed"))
    }

    // ── the view model ─────────────────────────────────────────────────────

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getAllKin() } returns Result.success(emptyList<Kin>())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun open(status: String) {
        coEvery { repository.getKinfolk() } returns Result.success(
            listOf(
                Kinfolk(
                    id = "kf-1", firstName = "Dre", lastName = "East", phoneNumber = "5125550134",
                    serviceAddress = "1 Mill St", status = status,
                )
            )
        )
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
        viewModel.loadKinfolkForEdit("kf-1")
    }

    @Test
    fun `the status picker cannot archive a household`() = runTest(testDispatcher) {
        open("active")
        advanceUntilIdle()
        viewModel.updateEditStatus("archived")
        assertEquals("active", viewModel.editKinfolkState.value.status)
        viewModel.updateEditStatus("prospect")
        assertEquals("prospect", viewModel.editKinfolkState.value.status)
    }

    @Test
    fun `the status picker cannot restore a household`() = runTest(testDispatcher) {
        open("archived")
        advanceUntilIdle()
        viewModel.updateEditStatus("active")
        assertEquals("archived", viewModel.editKinfolkState.value.status)
    }

    @Test
    fun `saving an archived household never sends a status`() = runTest(testDispatcher) {
        open("archived")
        advanceUntilIdle()
        val captured = slot<Map<String, Any>>()
        coEvery { repository.updateKinfolkFields(any(), capture(captured)) } returns Result.success(Unit)
        viewModel.updateEditStatus("active")
        viewModel.updateEditGateCode("1234")
        viewModel.saveKinfolkChanges()
        advanceUntilIdle()
        assertFalse(captured.captured.containsKey("status"))
        assertTrue(captured.captured.containsKey("gateCode"))
    }

    @Test
    fun `a refused archive shows the owner-only sentence and stays on the editor`() = runTest(testDispatcher) {
        open("active")
        advanceUntilIdle()
        val denied = mockk<FirebaseFunctionsException>()
        every { denied.code } returns FirebaseFunctionsException.Code.PERMISSION_DENIED
        every { denied.message } returns "Admin claim required."
        coEvery { repository.archiveKinfolk(any(), any()) } returns Result.failure(denied)

        viewModel.archiveKinfolk("moved away")
        advanceUntilIdle()

        assertEquals(KINFOLK_ARCHIVE_OWNER_ONLY, viewModel.editKinfolkState.value.error)
        assertFalse(viewModel.editKinfolkState.value.isDeleted)
    }

    @Test
    fun `a refused restore shows the owner-only sentence and the household stays archived`() = runTest(testDispatcher) {
        open("archived")
        advanceUntilIdle()
        val denied = mockk<FirebaseFunctionsException>()
        every { denied.code } returns FirebaseFunctionsException.Code.PERMISSION_DENIED
        every { denied.message } returns "Admin claim required."
        coEvery { repository.unarchiveKinfolk(any()) } returns Result.failure(denied)

        viewModel.unarchiveKinfolk()
        advanceUntilIdle()

        assertEquals(KINFOLK_ARCHIVE_OWNER_ONLY, viewModel.editKinfolkState.value.error)
        assertEquals("archived", viewModel.editKinfolkState.value.status)
    }

    @Test
    fun `after a restore the next save does not send the status again`() = runTest(testDispatcher) {
        open("archived")
        advanceUntilIdle()
        coEvery { repository.unarchiveKinfolk(any()) } returns Result.success("active")
        viewModel.unarchiveKinfolk()
        advanceUntilIdle()
        assertEquals("active", viewModel.editKinfolkState.value.status)

        val captured = slot<Map<String, Any>>()
        coEvery { repository.updateKinfolkFields(any(), capture(captured)) } returns Result.success(Unit)
        viewModel.updateEditGateCode("1234")
        viewModel.saveKinfolkChanges()
        advanceUntilIdle()
        coVerify(exactly = 1) { repository.updateKinfolkFields("kf-1", any()) }
        assertFalse(captured.captured.containsKey("status"))
    }
}
