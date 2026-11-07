package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1563: a stored KinTale draft could not be opened, sent or deleted from the
 * phone. Home's rows did nothing, its button opened a blank Communicate, and
 * approving a KinTale stamped the draft and reached nobody. These lock the
 * ViewModel half of the fix: open by id, send through `publishGeneratedDraft`,
 * delete through `deleteGeneratedDraft`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateDraftReviewTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    /** A May-era n8n draft, the shape the walk's five carry. */
    private val stored = Draft(
        id = "gd1",
        status = "pending",
        communicationType = "visit_report",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        generatedCopy = "Biscuit chased every leaf.",
        createdOn = "2026-05-23T22:23:00.000Z",
        generatedTitle = "Leaf patrol",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { repo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
        coEvery { repo.getHouseholdBank(any()) } returns Result.success(null)
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.getKin(any()) } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = CommunicateViewModel(repo = repo)

    @Test
    fun `loadDraft fills the form from the stored draft, household resolved`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored)
        val vm = vm()
        advanceUntilIdle()

        vm.loadDraft("gd1")
        advanceUntilIdle()

        val s = vm.uiState.value
        assertFalse(s.draftLoading)
        assertEquals("visit_report", s.commType)
        assertEquals("gd1", s.draftId)
        assertEquals("Biscuit chased every leaf.", s.generatedCopy)
        assertEquals("Leaf patrol", s.subject)
        assertEquals("kf1", s.selectedKinfolk?.id)
        assertNull(s.publishedReportId)
    }

    @Test
    fun `a draft opened before the kinfolk list lands resolves its household when it does`() = runTest(testDispatcher) {
        val list = CompletableDeferred<Result<List<com.tribetails.auntieos.data.model.Kinfolk>>>()
        coEvery { repo.getKinfolk() } coAnswers { list.await() }
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored)
        val vm = vm()

        vm.loadDraft("gd1")
        advanceUntilIdle()
        assertNull(vm.uiState.value.selectedKinfolk)
        assertEquals("kf1", vm.uiState.value.pendingKinfolkId)

        list.complete(Result.success(TestFixtures.allKinfolk))
        advanceUntilIdle()
        assertEquals("kf1", vm.uiState.value.selectedKinfolk?.id)
        assertNull(vm.uiState.value.pendingKinfolkId)
    }

    @Test
    fun `a stored sms draft opens on the SMS type`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored.copy(communicationType = "sms"))
        val vm = vm()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        assertEquals("sms", vm.uiState.value.commType)
    }

    @Test
    fun `a draft that is gone says so instead of opening a blank form`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(null)
        val vm = vm()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.draftLoadError)
        assertNull(vm.uiState.value.draftId)
    }

    @Test
    fun `a draft already sent opens as sent`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns
            Result.success(stored.copy(status = "published", publishedReportId = "r7"))
        val vm = vm()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        assertEquals("r7", vm.uiState.value.publishedReportId)
        assertTrue(vm.uiState.value.publishedBefore)
    }

    @Test
    fun `approving a KinTale sends it through publishGeneratedDraft with the edited copy`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored)
        coEvery { repo.publishGeneratedDraft(any(), any(), any()) } returns Result.success("r1")
        val vm = vm()
        vm.loadDraft("gd1")
        advanceUntilIdle()
        vm.setGeneratedCopy("Biscuit chased every leaf. Edited.")

        vm.approveDraft()
        advanceUntilIdle()

        coVerify(exactly = 1) { repo.publishGeneratedDraft("gd1", "Biscuit chased every leaf. Edited.", "Leaf patrol") }
        // The old approve stamped the draft and reached nobody; it must not run for a KinTale.
        coVerify(exactly = 0) { repo.approveDraft(any(), any(), any()) }
        assertEquals("r1", vm.uiState.value.publishedReportId)
        assertFalse(vm.uiState.value.isSaving)
        assertTrue(vm.uiState.value.successMessage!!.contains("Rosa Parks"))
    }

    @Test
    fun `a refused send says why and leaves the draft unsent`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored)
        coEvery { repo.publishGeneratedDraft(any(), any(), any()) } returns
            Result.failure(RuntimeException("The household this draft is addressed to no longer exists."))
        val vm = vm()
        vm.loadDraft("gd1")
        advanceUntilIdle()

        vm.approveDraft()
        advanceUntilIdle()

        assertNull(vm.uiState.value.publishedReportId)
        assertTrue(vm.uiState.value.error!!.contains("no longer exists"))
    }

    @Test
    fun `deleteDraft deletes through the callable and clears the form`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored)
        coEvery { repo.deleteGeneratedDraft("gd1") } returns Result.success(Unit)
        val vm = vm()
        vm.loadDraft("gd1")
        advanceUntilIdle()

        vm.deleteDraft()
        advanceUntilIdle()

        coVerify(exactly = 1) { repo.deleteGeneratedDraft("gd1") }
        assertTrue(vm.uiState.value.draftDeleted)
        assertNull(vm.uiState.value.draftId)
        assertEquals("", vm.uiState.value.generatedCopy)
    }

    @Test
    fun `a refused delete keeps the draft and says why`() = runTest(testDispatcher) {
        coEvery { repo.getGeneratedDraft("gd1") } returns Result.success(stored)
        coEvery { repo.deleteGeneratedDraft("gd1") } returns Result.failure(RuntimeException("Admin claim required."))
        val vm = vm()
        vm.loadDraft("gd1")
        advanceUntilIdle()

        vm.deleteDraft()
        advanceUntilIdle()

        assertEquals("gd1", vm.uiState.value.draftId)
        assertFalse(vm.uiState.value.draftDeleted)
        assertEquals("Admin claim required.", vm.uiState.value.error)
    }

    @Test
    fun `commTypeOfDraft reads blank and unknown types as a KinTale`() {
        assertEquals("visit_report", commTypeOfDraft(""))
        assertEquals("visit_report", commTypeOfDraft("something_new"))
        assertEquals("sms", commTypeOfDraft(" SMS "))
        assertEquals("email", commTypeOfDraft("email"))
    }
}
