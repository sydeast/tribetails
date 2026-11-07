package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.model.canDeleteAsDraft
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
import io.mockk.coVerify
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1631: an unsent KinTale report draft could not be deleted from the phone.
 * Only the purgeOldDrafts retention job removed one. These pin the gate (the
 * server's three refusals) and the ViewModel's delete through the
 * `deleteKinTaleReportDraft` callable.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleDraftDeleteTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        kinCareRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = KinTaleReportViewModel(
        repository = repo,
        kinCareRepository = kinCareRepo,
        mediaUploader = mockk<MediaUploadManager>(relaxed = true),
        notifier = mockk<VisitNotifier>(relaxed = true),
    )

    private fun TestScope.open(vm: KinTaleReportViewModel, report: KinCareReport) {
        coEvery { kinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1.copy(kinfolkId = "kf1"))
        coEvery { repo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { repo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { repo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareReport("rep1") } returns Result.success(report)
        vm.load("ses1", "rep1")
        advanceUntilIdle()
    }

    private val draft = KinCareReport(
        id = "rep1",
        kinfolkId = "kf1",
        status = ReportStatus.DRAFT.name,
        sentAt = "",
        bodyCopy = "Biscuit had a great walk.",
    )

    @Test
    fun `an unsent saved draft can be deleted`() {
        assertTrue(draft.canDeleteAsDraft())
        assertTrue(draft.copy(status = "draft").canDeleteAsDraft())
    }

    @Test
    fun `a sent KinTale, a draft with a send time and an unsaved draft cannot`() {
        assertFalse(draft.copy(status = ReportStatus.SENT.name, sentAt = "2026-11-04T19:00:00Z").canDeleteAsDraft())
        assertFalse(draft.copy(sentAt = "2026-11-04T19:00:00Z").canDeleteAsDraft())
        assertFalse(draft.copy(id = "").canDeleteAsDraft())
    }

    @Test
    fun `an untriaged migration orphan cannot, it belongs to Needs triage`() {
        assertFalse(draft.copy(kinfolkId = "", sentVia = "legacy_orphan").canDeleteAsDraft())
        assertTrue(draft.copy(kinfolkId = "", sentVia = "legacy_orphan", triageStatus = "ASSIGNED").canDeleteAsDraft())
    }

    @Test
    fun `deleteDraft calls the server and marks the screen done`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.deleteKinTaleReportDraft("rep1") } returns Result.success(Unit)
        val vm = vm()
        open(vm, draft)
        vm.deleteDraft()
        advanceUntilIdle()
        coVerify(exactly = 1) { kinCareRepo.deleteKinTaleReportDraft("rep1") }
        assertTrue(vm.uiState.value.deletedSuccessfully)
        assertFalse(vm.uiState.value.isDeleting)
    }

    @Test
    fun `a refused delete names the reason and stays on the screen`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.deleteKinTaleReportDraft("rep1") } returns
            Result.failure(IllegalStateException("This KinTale has a send time, so the household may have it."))
        val vm = vm()
        open(vm, draft)
        vm.deleteDraft()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.deletedSuccessfully)
        assertEquals("This KinTale has a send time, so the household may have it.", vm.uiState.value.error)
    }

    @Test
    fun `deleteDraft refuses a sent KinTale without calling the server`() = runTest(testDispatcher) {
        val vm = vm()
        open(vm, draft.copy(status = ReportStatus.SENT.name, sentAt = "2026-11-04T19:00:00Z"))
        vm.deleteDraft()
        advanceUntilIdle()
        coVerify(exactly = 0) { kinCareRepo.deleteKinTaleReportDraft(any()) }
        assertFalse(vm.uiState.value.deletedSuccessfully)
    }

    @Test
    fun `the confirm names the household`() {
        assertEquals(
            "This KinTale for Robyn has not been sent. Deleting it cannot be undone.",
            deleteDraftConfirmText("Robyn"),
        )
        assertEquals("This KinTale has not been sent. Deleting it cannot be undone.", deleteDraftConfirmText(" "))
    }
}
