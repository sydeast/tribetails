package com.tribetails.auntieos.ui.kintales

import android.content.Context
import android.net.Uri
import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.GenerateResponse
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
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
 * The KinTale composer's draft lifecycle on Android.
 *
 * #2040: "Send the KinTale" on Auntie Time names only the visit. A visit that
 * already has a saved draft reopens it, the newest if there are two, and a failed
 * look for it refuses rather than starting a second draft.
 *
 * #1940: a SENT KinTale opened for editing is never written by the automatic
 * save paths (typing, blur, Back), only by Save changes, and is never sent again.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleDraftLifecycleTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private lateinit var uploader: MediaUploadManager
    private lateinit var notifier: VisitNotifier

    private val savedDraft = KinCareReport(
        id = "rep-draft",
        sessionId = "ses1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        title = "Park day",
        bodyCopy = "Biscuit found a stick.",
        status = ReportStatus.DRAFT.name,
        sentAt = "",
        createdAt = "2026-06-02T10:00:00Z",
        updatedAt = "2026-06-02T10:05:00Z",
    )

    private val sentTale = savedDraft.copy(
        id = "rep-sent",
        status = ReportStatus.SENT.name,
        sentAt = "2026-06-02T11:00:00Z",
        sentVia = "catalog",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        kinCareRepo = mockk()
        uploader = mockk(relaxed = true)
        notifier = mockk(relaxed = true)

        coEvery { kinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { repo.getKinfolkById(any()) } returns Result.success(TestFixtures.kinfolk1)
        coEvery { repo.getKin(any()) } returns Result.success(emptyList())
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { repo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { kinCareRepo.updateKinCareReportFields(any(), any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.createKinCareReport(any()) } returns Result.success("rep-new")
        coEvery { kinCareRepo.getReportsForVisit(any()) } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareReport("rep-sent") } returns Result.success(sentTale)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = KinTaleReportViewModel(
        repository = repo,
        kinCareRepository = kinCareRepo,
        mediaUploader = uploader,
        notifier = notifier,
    )

    // ── #2040: the pure pick ────────────────────────────────────────────────

    @Test
    fun `newestSavedDraft finds this visit's draft`() {
        val other = savedDraft.copy(id = "elsewhere", sessionId = "ses2")
        assertEquals("rep-draft", newestSavedDraft(listOf(other, savedDraft), "ses1")?.id)
    }

    @Test
    fun `newestSavedDraft ignores a sent tale, a send stamp and an unknown status`() {
        val rows = listOf(
            sentTale,
            savedDraft.copy(id = "stamped", sentAt = "2026-06-02T11:00:00Z"),
            savedDraft.copy(id = "failed", status = ReportStatus.FAILED.name),
            savedDraft.copy(id = "blank", status = ""),
        )
        assertNull(newestSavedDraft(rows, "ses1"))
    }

    @Test
    fun `newestSavedDraft picks the newest of two by updatedAt then createdAt then id`() {
        val older = savedDraft.copy(id = "a", updatedAt = "2026-06-02T10:00:00Z", createdAt = "2026-06-02T10:00:00Z")
        val newer = savedDraft.copy(id = "b", updatedAt = "2026-06-02T12:00:00Z", createdAt = "2026-06-02T09:00:00Z")
        assertEquals("b", newestSavedDraft(listOf(newer, older), "ses1")?.id)
        val tieA = savedDraft.copy(id = "a", updatedAt = "", createdAt = "2026-06-02T10:00:00Z")
        val tieB = savedDraft.copy(id = "b", updatedAt = "", createdAt = "2026-06-02T09:00:00Z")
        assertEquals("a", newestSavedDraft(listOf(tieB, tieA), "ses1")?.id)
        val sameA = savedDraft.copy(id = "a", updatedAt = "x", createdAt = "x")
        val sameB = savedDraft.copy(id = "b", updatedAt = "x", createdAt = "x")
        assertEquals("b", newestSavedDraft(listOf(sameA, sameB), "ses1")?.id)
    }

    @Test
    fun `newestSavedDraft matches nothing for a blank visit id`() {
        assertNull(newestSavedDraft(listOf(savedDraft.copy(sessionId = "")), ""))
    }

    // ── #2040: Send the KinTale reopens the saved draft ──────────────────────

    @Test
    fun `a new KinTale on a visit with a saved draft opens that draft`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.success(listOf(savedDraft))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.reportLoadFailed)
        assertEquals("rep-draft", state.report.id)
        assertEquals("Park day", state.report.title)
        assertEquals("Biscuit found a stick.", state.report.bodyCopy)
    }

    @Test
    fun `an edit to the reopened draft updates it and never creates a second one`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.success(listOf(savedDraft))
        val changes = slot<Map<String, Any?>>()
        coEvery { kinCareRepo.updateKinCareReportFields("rep-draft", capture(changes)) } returns Result.success(Unit)
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("Park day!")
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(setOf("title"), changes.captured.keys)
        coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
    }

    @Test
    fun `two saved drafts open the newest`() = runTest(testDispatcher) {
        val older = savedDraft.copy(id = "old", title = "First go", updatedAt = "2026-06-02T09:00:00Z")
        val newer = savedDraft.copy(id = "new", title = "Second go", updatedAt = "2026-06-02T12:00:00Z")
        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.success(listOf(older, newer))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()
        assertEquals("new", vm.uiState.value.report.id)
        assertEquals("Second go", vm.uiState.value.report.title)
    }

    @Test
    fun `a visit whose only KinTale is sent starts a new draft`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.success(listOf(sentTale))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()
        assertEquals("", vm.uiState.value.report.id)
        assertEquals(ReportStatus.DRAFT.name, vm.uiState.value.report.status)
        assertFalse(vm.uiState.value.reportLoadFailed)
    }

    @Test
    fun `a failed look for the saved draft refuses, and nothing typed is written`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.failure(RuntimeException("offline"))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.reportLoadFailed)
        assertEquals("Couldn't check this visit for a saved draft: offline", vm.uiState.value.error)

        vm.updateBodyCopy("Typed over a draft we could not see.")
        vm.persistDraft()
        advanceUntilIdle()
        coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
    }

    @Test
    fun `Retry after a failed look finds the draft`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.failure(RuntimeException("offline"))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()
        assertTrue(vm.uiState.value.reportLoadFailed)

        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.success(listOf(savedDraft))
        vm.retryLoad()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.reportLoadFailed)
        assertEquals("rep-draft", vm.uiState.value.report.id)
    }

    // ── #1940: editing a sent KinTale ────────────────────────────────────────

    private fun openSent(): KinTaleReportViewModel {
        val vm = buildViewModel()
        vm.load("ses1", "rep-sent")
        return vm
    }

    @Test
    fun `typing on a sent tale never autosaves, and blur or Back never write`() = runTest(testDispatcher) {
        val vm = openSent()
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit found a stick and a friend.")
        advanceTimeBy(KinTaleReportViewModel.AUTOSAVE_DEBOUNCE_MS * 3)
        advanceUntilIdle()
        vm.persistDraft() // blur, a toggle, or Back
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        assertTrue(vm.uiState.value.hasUnsavedChanges)
    }

    @Test
    fun `no toggle, mood, photo or generated draft writes a sent tale until Save changes`() = runTest(testDispatcher) {
        coEvery { uploader.uploadMedia(any(), any(), any(), any(), any(), any()) } returns
            Result.success(MediaFile(id = "media-new", storageUrl = "https://res.cloudinary.com/demo/image/upload/new.jpg"))
        coEvery { repo.generate(any(), any()) } returns
            Result.success(GenerateResponse(generatedCopy = "Biscuit found a stick, then a friend."))
        val vm = openSent()
        advanceUntilIdle()

        vm.setChecklistResponse("fed", "", true)
        vm.setBoolField("walked", "kin1", true)
        vm.setIntField("treats", "kin1", 2)
        vm.setStringField("note", "kin1", "Napped by the window")
        vm.setMoodForKin("kin1", "happy")
        vm.updateFormValue("gate", "Locked")
        vm.addMedia(mockk<Context>(relaxed = true), mockk<Uri>(relaxed = true))
        advanceUntilIdle()
        vm.removeMedia("media-new")
        vm.generateDraft()
        advanceTimeBy(KinTaleReportViewModel.AUTOSAVE_DEBOUNCE_MS * 3)
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
        assertTrue(vm.uiState.value.hasUnsavedChanges)
        assertEquals("Biscuit found a stick, then a friend.", vm.uiState.value.report.bodyCopy)
        assertEquals(ReportStatus.SENT.name, vm.uiState.value.report.status)
    }

    @Test
    fun `Save changes writes only the changed field, never a status or send stamp, and sends nothing`() = runTest(testDispatcher) {
        val changes = slot<Map<String, Any?>>()
        coEvery { kinCareRepo.updateKinCareReportFields("rep-sent", capture(changes)) } returns Result.success(Unit)
        val vm = openSent()
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit found a stick and a friend.")
        vm.saveChanges()
        advanceUntilIdle()

        assertEquals(setOf("bodyCopy"), changes.captured.keys)
        assertFalse(vm.uiState.value.hasUnsavedChanges)
        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
        assertEquals(ReportStatus.SENT.name, vm.uiState.value.report.status)
        coVerify(exactly = 0) { kinCareRepo.markReportSent(any(), any(), any(), any()) }
        coVerify(exactly = 0) { notifier.notify(any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a failed Save changes says so and leaves the changes unsaved`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.updateKinCareReportFields("rep-sent", any()) } returns Result.failure(RuntimeException("offline"))
        val vm = openSent()
        advanceUntilIdle()

        vm.updateTitle("Park day, part two")
        vm.saveChanges()
        advanceUntilIdle()

        assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)
        assertEquals("Couldn't save: offline", vm.uiState.value.error)
        assertTrue(vm.uiState.value.hasUnsavedChanges)
    }

    @Test
    fun `a sent tale is never sent again`() = runTest(testDispatcher) {
        val vm = openSent()
        advanceUntilIdle()

        vm.send()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertEquals("This KinTale has already been sent. Save your changes instead.", vm.uiState.value.error)
        coVerify(exactly = 0) { notifier.notify(any(), any(), any(), any(), any(), any()) }
        coVerify(exactly = 0) { kinCareRepo.markReportSent(any(), any(), any(), any()) }
        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
    }

    @Test
    fun `a draft still autosaves as before`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getReportsForVisit("ses1") } returns Result.success(listOf(savedDraft))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit found two sticks.")
        advanceTimeBy(KinTaleReportViewModel.AUTOSAVE_DEBOUNCE_MS + 1)
        advanceUntilIdle()

        coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields("rep-draft", any()) }
    }

    @Test
    fun `the sent note names the household and when a notice goes out`() {
        assertEquals(
            "This KinTale has been sent. Rosa Parks will see your changes once you save them. " +
                "New words or a new photo also send them a notice that you added to it, at most one a minute.",
            sentKinTaleEditNote("Rosa Parks"),
        )
        assertTrue(sentKinTaleEditNote(" ").startsWith("This KinTale has been sent. The household will see"))
    }
}
