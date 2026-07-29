package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.GenerateRequest
import com.tribetails.auntieos.data.model.GenerateResponse
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.KinTaleTemplate
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

@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleReportViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockKinCareRepo: KinCareRepository
    private lateinit var mockUploader: MediaUploadManager
    private lateinit var mockNotifier: VisitNotifier

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockKinCareRepo = mockk()
        mockUploader = mockk(relaxed = true)
        mockNotifier = mockk(relaxed = true)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = KinTaleReportViewModel(
        repository = mockRepo,
        kinCareRepository = mockKinCareRepo,
        mediaUploader = mockUploader,
        notifier = mockNotifier
    )

    @Test
    fun `load sets error when session not found`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession(any()) } returns Result.success(null)

        val vm = buildViewModel()
        vm.load("ses99", null)
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isLoading)
        assertNotNull(vm.uiState.value.error)
        assertEquals("Session not found", vm.uiState.value.error)
    }

    @Test
    fun `load populates session and kinfolk on success`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertNull(state.error)
        assertEquals(TestFixtures.session1, state.session)
        assertEquals(TestFixtures.kinfolk1, state.kinfolk)
    }

    @Test
    fun `updateBodyCopy updates report bodyCopy in state`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit had a great walk!")

        assertEquals("Biscuit had a great walk!", vm.uiState.value.report.bodyCopy)
    }

    @Test
    fun `send sets error when no content`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.send()

        assertNotNull(vm.uiState.value.error)
    }

    @Test
    fun `persistDraft does nothing when report has no content`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(SaveStatus.IDLE, vm.uiState.value.saveStatus)
    }

    @Test
    fun `persistDraft creates new report when it has content and no id`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { mockKinCareRepo.createKinCareReport(any()) } returns Result.success("newId")

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("Great visit!")
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
        assertEquals("newId", vm.uiState.value.report.id)
    }

    // H-A1: send() when session has empty kinfolkId (kinfolk = null) must surface an error
    @Test
    fun `send sets error when kinfolk is null because session kinfolkId is empty`() = runTest(testDispatcher) {
        val sessionNoKinfolk = TestFixtures.session1.copy(kinfolkId = "")
        coEvery { mockKinCareRepo.getKinCareSession("ses-nk") } returns Result.success(sessionNoKinfolk)
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses-nk", null)
        advanceUntilIdle()

        // Give the report some content so the only barrier is missing kinfolk
        vm.updateBodyCopy("Great visit!")
        vm.send()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isSending)
        assertNotNull(
            "send() must set an error when kinfolk is null - not silently return",
            vm.uiState.value.error
        )
    }

    // ---- Slice 5: delivery receipt from the dispatch pipeline ----

    @Test
    fun `send writes the first dispatchId as the delivery receipt`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { mockKinCareRepo.createKinCareReport(any()) } returns Result.success("rep-1")
        coEvery { mockKinCareRepo.updateKinCareReport(any()) } returns Result.success(Unit)
        coEvery { mockNotifier.notify(VisitNotifier.Event.REPORT_SENT, any(), any(), any()) } returns
            Result.success(VisitNotifier.DispatchResult(dispatchIds = listOf("n8n_77", "n8n_88"), suppressed = false))

        val viaSlot = slot<String>()
        val receiptSlot = slot<String>()
        coEvery {
            mockKinCareRepo.markReportSent(any(), any(), capture(viaSlot), capture(receiptSlot))
        } returns Result.success(Unit)

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()
        vm.updateBodyCopy("Biscuit had a great walk!")
        vm.send()
        advanceUntilIdle()

        assertTrue(vm.uiState.value.sentSuccessfully)
        assertEquals("catalog", viaSlot.captured)
        assertEquals("n8n_77", receiptSlot.captured)
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `send dispatch failure leaves status DRAFT and sets error`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { mockKinCareRepo.createKinCareReport(any()) } returns Result.success("rep-1")
        coEvery { mockKinCareRepo.updateKinCareReport(any()) } returns Result.success(Unit)
        coEvery { mockNotifier.notify(VisitNotifier.Event.REPORT_SENT, any(), any(), any()) } returns
            Result.failure(IllegalStateException("session not booking-originated"))

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()
        vm.updateBodyCopy("Biscuit had a great walk!")
        vm.send()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.sentSuccessfully)
        assertNotNull(vm.uiState.value.error)
        // Status never flipped to SENT, so the auntie can retry.
        assertFalse(vm.uiState.value.report.status == ReportStatus.SENT.name)
    }

    // ---- Slice 3: headline (title) + pet-mood persistence ----

    @Test
    fun `updateTitle updates report title in state`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("Checking on Biscuit")

        assertEquals("Checking on Biscuit", vm.uiState.value.report.title)
    }

    @Test
    fun `persistDraft persists the typed title and mood on the created report`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        val captured = slot<KinCareReport>()
        coEvery { mockKinCareRepo.createKinCareReport(capture(captured)) } returns Result.success("newId")

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        // updateTitle alone is enough content to persist (title counts in hasContent).
        vm.updateTitle("Checking on Biscuit")
        vm.setMoodForKin("kinA", "happy") // setMoodForKin auto-persists
        advanceUntilIdle()

        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
        assertEquals("Checking on Biscuit", captured.captured.title)
        assertEquals("happy", captured.captured.petMoodSelections["kinA"])
    }

    @Test
    fun `persistDraft surfaces error on create failure and keeps the title`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { mockKinCareRepo.createKinCareReport(any()) } returns Result.failure(RuntimeException("write failed"))

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("Checking on Biscuit")
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)
        // Local draft intact so a retry still carries the headline.
        assertEquals("Checking on Biscuit", vm.uiState.value.report.title)
    }

    @Test
    fun `clearError resets error to null`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.send()
        assertNotNull(vm.uiState.value.error)

        vm.clearError()
        assertNull(vm.uiState.value.error)
    }

    // ---- Slice 9: kin-name join integration (load() -> uiState.kinList -> heading) ----

    private val biscuit = com.tribetails.auntieos.data.model.Kin(
        id = "kin1", name = "Biscuit", kinfolkId = "kf1", species = "Dog", breed = "Labrador",
    )
    private val gravy = com.tribetails.auntieos.data.model.Kin(
        id = "kin2", name = "Gravy", kinfolkId = "kf1", species = "Cat",
    )

    @Test
    fun `load populates kinList filtered by session kinIds and joins heading`() = runTest(testDispatcher) {
        val session = TestFixtures.session1.copy(kinfolkId = "kf1", kinIds = listOf("kin1"))
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(session)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(listOf(biscuit, gravy))
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        val state = vm.uiState.value
        // Only the kin in session.kinIds is kept; the join reads name/species/breed.
        assertEquals(listOf("kin1"), state.kinList.map { it.id })
        assertEquals("Biscuit · Dog · Labrador", kinHeading(state.kinList.first()))
        assertNull(state.error)
    }

    @Test
    fun `load yields empty kinList when no kin resolve`() = runTest(testDispatcher) {
        val session = TestFixtures.session1.copy(kinfolkId = "kf1", kinIds = emptyList())
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(session)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.kinList.isEmpty())
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `load with failing getKin keeps kinList empty and does not crash`() = runTest(testDispatcher) {
        val session = TestFixtures.session1.copy(kinfolkId = "kf1", kinIds = listOf("kin1"))
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(session)
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.failure(RuntimeException("kin query failed"))
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        // load() uses getOrDefault(emptyList()): a kin failure must not blow up the screen.
        assertTrue(vm.uiState.value.kinList.isEmpty())
        // Session still resolved, so this is not the "Session not found" error path.
        assertNull(vm.uiState.value.error)
    }

    // ---- View-as-kinfolk preview + share link ----------------------------------

    @Test
    fun `toggleViewAsKinfolk flips the preview flag`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        assertFalse(vm.uiState.value.viewAsKinfolk)
        vm.toggleViewAsKinfolk()
        assertTrue(vm.uiState.value.viewAsKinfolk)
        vm.toggleViewAsKinfolk()
        assertFalse(vm.uiState.value.viewAsKinfolk)
    }

    @Test
    fun `requestShareLink fails loud when report not saved`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        // No load: report.id is blank.
        vm.requestShareLink()
        advanceUntilIdle()
        assertEquals("Save the report before sharing.", vm.uiState.value.shareError)
        assertNull(vm.uiState.value.shareUrl)
    }

    /** Loads an existing report doc so report.id + kinfolkId are populated. */
    private fun kotlinx.coroutines.test.TestScope.loadExistingReport(vm: KinTaleReportViewModel, report: KinCareReport) {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(
            TestFixtures.session1.copy(kinfolkId = "kf1"),
        )
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { mockRepo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { mockKinCareRepo.getKinCareReport("rep1") } returns Result.success(report)
        vm.load("ses1", "rep1")
        advanceUntilIdle()
    }

    @Test
    fun `requestShareLink fails loud when kinfolkId missing`() = runTest(testDispatcher) {
        val report = KinCareReport(id = "rep1", kinfolkId = "", status = ReportStatus.SENT.name)
        val vm = buildViewModel()
        loadExistingReport(vm, report)
        vm.requestShareLink()
        advanceUntilIdle()
        assertEquals("Could not share: recipient kinfolk is missing.", vm.uiState.value.shareError)
        assertNull(vm.uiState.value.shareUrl)
    }

    @Test
    fun `requestShareLink stores url on success`() = runTest(testDispatcher) {
        val report = KinCareReport(id = "rep1", kinfolkId = "kf1", status = ReportStatus.SENT.name)
        coEvery { mockKinCareRepo.createShareLink("rep1", "kf1", any()) } returns
            Result.success(KinCareRepository.ShareLinkResult("share123", "https://share/share123"))
        val vm = buildViewModel()
        loadExistingReport(vm, report)
        vm.requestShareLink()
        advanceUntilIdle()
        assertEquals("https://share/share123", vm.uiState.value.shareUrl)
        assertNull(vm.uiState.value.shareError)
        assertFalse(vm.uiState.value.isSharing)
    }

    @Test
    fun `requestShareLink surfaces callable failure as shareError`() = runTest(testDispatcher) {
        val report = KinCareReport(id = "rep1", kinfolkId = "kf1", status = ReportStatus.SENT.name)
        coEvery { mockKinCareRepo.createShareLink("rep1", "kf1", any()) } returns
            Result.failure(RuntimeException("permission-denied"))
        val vm = buildViewModel()
        loadExistingReport(vm, report)
        vm.requestShareLink()
        advanceUntilIdle()
        assertNull(vm.uiState.value.shareUrl)
        assertTrue(vm.uiState.value.shareError!!.contains("permission-denied"))
        assertFalse(vm.uiState.value.isSharing)
    }

    @Test
    fun `clearShareError resets shareError to null`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.requestShareLink() // sets the "save first" error
        assertNotNull(vm.uiState.value.shareError)
        vm.clearShareError()
        assertNull(vm.uiState.value.shareError)
    }

    // ---- View-as-kinfolk pure preview helpers ----------------------------------

    @Test
    fun `kinfolkPreviewBody prefers body copy then honest fallback`() {
        assertEquals("Walked the block.", kinfolkPreviewBody(KinCareReport(bodyCopy = "Walked the block.")))
        assertEquals("No narrative was written for this visit.", kinfolkPreviewBody(KinCareReport(bodyCopy = "")))
    }

    @Test
    fun `kinfolkPreviewHeadline prefers title then author-recipient line`() {
        assertEquals("Clementine day", kinfolkPreviewHeadline(KinCareReport(title = "Clementine day")))
        assertEquals(
            "From Auntie Mae for The Smiths",
            kinfolkPreviewHeadline(
                KinCareReport(title = "", authorDisplayName = "Auntie Mae", kinfolkName = "The Smiths"),
            ),
        )
        assertEquals(
            "From Auntie for your kinfolk",
            kinfolkPreviewHeadline(KinCareReport(title = "", authorDisplayName = "", kinfolkName = "")),
        )
    }

    // ── Generate-draft action (Scope C) ──────────────────────────────────────
    private suspend fun kotlinx.coroutines.test.TestScope.loadedVmWithKinfolk(): KinTaleReportViewModel {
        coEvery { mockKinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { mockRepo.getKinfolkById(any()) } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getKin(any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { mockRepo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { mockKinCareRepo.createKinCareReport(any()) } returns Result.success("rep1")
        coEvery { mockKinCareRepo.updateKinCareReport(any()) } returns Result.success(Unit)
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()
        return vm
    }

    @Test
    fun `generateDraft fills the body and tracks the opener`() = runTest(testDispatcher) {
        val vm = loadedVmWithKinfolk()
        vm.updateBodyCopy("fed mia and milo, cleaned the boxes")
        val reqSlot = slot<GenerateRequest>()
        coEvery { mockRepo.generate(capture(reqSlot), any()) } returns
            Result.success(GenerateResponse(generatedCopy = "The cats were already at the door."))

        vm.generateDraft(useFunction = true)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isGenerating)
        assertEquals("The cats were already at the door.", state.report.bodyCopy)
        assertEquals("The", state.lastOpening)
        assertEquals("visit_report", reqSlot.captured.communication_type)
        assertNull(reqSlot.captured.avoid_opening)
        // The linked household's real id, so the server reads that doc rather
        // than re-deriving it from the display name and risking a second
        // household with the same first name.
        assertEquals("kf1", reqSlot.captured.kinfolk_id)
    }

    @Test
    fun `generateDraft regenerate feeds the prior opener back as avoid_opening`() = runTest(testDispatcher) {
        val vm = loadedVmWithKinfolk()
        vm.updateBodyCopy("fed the cats")
        val reqs = mutableListOf<GenerateRequest>()
        coEvery { mockRepo.generate(capture(reqs), any()) } returnsMany listOf(
            Result.success(GenerateResponse(generatedCopy = "Well!!!! they were great.")),
            Result.success(GenerateResponse(generatedCopy = "Nova greeted me at the door.")),
        )

        vm.generateDraft()
        advanceUntilIdle()
        vm.generateDraft()
        advanceUntilIdle()

        assertEquals(2, reqs.size)
        assertNull(reqs[0].avoid_opening)
        assertEquals("Well!!!!", reqs[1].avoid_opening)
        assertEquals("Nova", vm.uiState.value.lastOpening)
    }

    @Test
    fun `generateDraft with blank notes errors and never calls the generator`() = runTest(testDispatcher) {
        val vm = loadedVmWithKinfolk()
        vm.generateDraft()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        coVerify(exactly = 0) { mockRepo.generate(any(), any()) }
    }
}
