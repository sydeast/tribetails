package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.CapturingSlot
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

/**
 * Every KinTale draft save writes a DIFF against the copy Firestore handed over,
 * and a draft that could not be READ is never saveable over the real record.
 *
 * `kin_care_reports/{id}` has four writers (see `KinCareReportDiff.kt`), and the
 * editor used to hand it `.set(wholeModel, merge())` - the shape #312, #315, #327
 * and #332 removed from their own collections, and the one #332 named this site as
 * still carrying.
 *
 * TWO KINDS OF TEST LIVE HERE, and only the second kind is load-bearing. "The
 * edited body was written" passes on the broken code too and proves nothing. What
 * the broken code fails is: a save must not carry fields the operator did not
 * touch, a save that changed nothing must not write, and a draft whose read FAILED
 * must not be saveable at all.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleDraftSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private lateinit var uploader: MediaUploadManager
    private lateinit var notifier: VisitNotifier

    /**
     * The KinTale as it stood when the phone read it: a half-written draft that has
     * already been through orphan triage and carries photos and mood picks.
     */
    private val stored = KinCareReport(
        id = "rep-1",
        sessionId = "ses1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        authorId = "auntie-1",
        authorDisplayName = "Auntie Rae",
        serviceType = "Dog Walking",
        visitDate = "2026-06-02T10:00:00",
        title = "Biscuit's afternoon",
        bodyCopy = "Biscuit met the neighbour's cat.",
        mediaFileIds = listOf("m-1", "m-2"),
        petMoodSelections = mapOf("kin1" to "happy"),
        status = ReportStatus.DRAFT.name,
        triageStatus = "assigned",
        triagedAt = "2026-06-01T09:00:00Z",
        triagedBy = "admin-1",
        updatedAt = "2026-06-02T10:05:00Z",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        kinCareRepo = mockk()
        uploader = mockk(relaxed = true)
        notifier = mockk(relaxed = true)

        coEvery { kinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { repo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { repo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { repo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareReport("rep-1") } returns Result.success(stored)
        coEvery { kinCareRepo.updateKinCareReportFields(any(), any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.createKinCareReport(any()) } returns Result.success("rep-new")
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

    private fun captureChanges(): CapturingSlot<Map<String, Any?>> {
        val changes = slot<Map<String, Any?>>()
        coEvery { kinCareRepo.updateKinCareReportFields(any(), capture(changes)) } returns Result.success(Unit)
        return changes
    }

    /** A ViewModel that has successfully resumed the stored draft. */
    private fun resumedViewModel(): KinTaleReportViewModel {
        val vm = buildViewModel()
        vm.load("ses1", "rep-1")
        return vm
    }

    // ── the ordinary path ────────────────────────────────────────────────────

    @Test
    fun `a save writes the edited body and nothing else`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit met the cat and made a friend.")
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(setOf("bodyCopy"), changes.captured.keys)
        assertEquals("Biscuit met the cat and made a friend.", changes.captured["bodyCopy"])
        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
    }

    // ── THE CONCURRENT-EDIT CASE, the one the broken code fails ──────────────

    /**
     * An auntie opens a half-written KinTale on her phone and starts typing. While
     * the draft sits there, an admin triages the same report in KinTale Logs - the
     * `triageOrphanReport` callable stamps `triageStatus`, `triagedAt`, `triagedBy`
     * and the resolved `kinfolkId`/`kinfolkName` on the document. The auntie then
     * blurs the body field.
     *
     * The write must carry `bodyCopy` and NOTHING else. On the old code it carried
     * all 30 modelled fields at the values the phone read minutes earlier, so the
     * triage decision was reverted to whatever this client last saw - the report
     * dropped back into the Needs Triage bucket with the admin's decision erased,
     * silently, on an ordinary keystroke-and-blur.
     *
     * A test that only asserts "bodyCopy was written" passes on the broken code
     * too. The assertion that matters is the KEY SET.
     */
    @Test
    fun `a body edit does not revert a triage decision made while the draft was open`() =
        runTest(testDispatcher) {
            val changes = captureChanges()
            val vm = resumedViewModel()
            advanceUntilIdle()

            // ... admin triages the report in KinTale Logs, server-side ...

            vm.updateBodyCopy("Biscuit met the cat and made a friend.")
            vm.persistDraft()
            advanceUntilIdle()

            assertEquals(
                "a draft save must carry only the field the operator edited",
                setOf("bodyCopy"),
                changes.captured.keys,
            )
            listOf("triageStatus", "triagedAt", "triagedBy", "kinfolkId", "kinfolkName")
                .forEach {
                    assertFalse(
                        "stale $it in a draft save: ${changes.captured.keys}",
                        changes.captured.containsKey(it),
                    )
                }
        }

    /**
     * The same shape one field over, and the one that loses the auntie's own work:
     * the send lifecycle. `markReportSent` patches `status`/`sentAt`/`sentVia`/
     * `deliveryReceiptId`. A draft still open on a second device that then persists
     * used to write `status = DRAFT` back over the `SENT` it never saw.
     */
    @Test
    fun `a draft save never writes the send lifecycle back to DRAFT`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateTitle("Biscuit's big afternoon")
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(setOf("title"), changes.captured.keys)
        assertFalse(changes.captured.containsKey("status"))
        assertFalse(changes.captured.containsKey("sentAt"))
    }

    /** The stamps the phone read must never ride along in the write. */
    @Test
    fun `the stamps the phone read are never part of the write`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("something new")
        vm.persistDraft()
        advanceUntilIdle()

        assertFalse("stale updatedAt in the write", changes.captured.containsKey("updatedAt"))
        assertFalse("stale createdAt in the write", changes.captured.containsKey("createdAt"))
        assertFalse("document id in the write", changes.captured.containsKey("id"))
        assertFalse("stale authorId in the write", changes.captured.containsKey("authorId"))
    }

    /**
     * NOTHING CHANGED MEANS NOTHING IS WRITTEN, not even the stamp. This is reachable
     * from today's UI on every screen: the Save Draft button, and every blur of a
     * field the operator looked at without editing, called persistDraft
     * unconditionally. Once the editor autosaves it is reachable constantly.
     */
    @Test
    fun `a save that changed nothing writes nothing, not even the stamp`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.persistDraft()
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        assertNull(vm.uiState.value.error)
    }

    /** Typing something and undoing it is the same non-write. */
    @Test
    fun `an edit typed and undone writes nothing`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("half a thought")
        vm.updateBodyCopy(stored.bodyCopy)
        vm.persistDraft()
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
    }

    /**
     * The baseline advances to what the server now holds. Without it a second save
     * re-sends the first save's fields, which is the same clobber one step later -
     * and with an autosave on top, "one step later" is every few seconds.
     */
    @Test
    fun `a second save with no further edit writes nothing`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("a new body")
        vm.persistDraft()
        advanceUntilIdle()
        vm.persistDraft()
        advanceUntilIdle()

        coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }
    }

    /**
     * The baseline advances only after a write the SERVER accepted, so a rejected
     * save leaves the edit pending and the retry still carries it. This is the whole
     * offline story for the autosave that follows: a failed write never marks the
     * work saved and never drops it.
     */
    @Test
    fun `a rejected save leaves the edit pending for the retry`() = runTest(testDispatcher) {
        val changes = slot<Map<String, Any?>>()
        coEvery { kinCareRepo.updateKinCareReportFields(any(), capture(changes)) } returns
            Result.failure(RuntimeException("Write denied"))
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("a new body")
        vm.persistDraft()
        advanceUntilIdle()
        assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)
        assertNotNull(vm.uiState.value.error)

        coEvery { kinCareRepo.updateKinCareReportFields(any(), capture(changes)) } returns Result.success(Unit)
        vm.persistDraft()
        advanceUntilIdle()

        assertEquals(setOf("bodyCopy"), changes.captured.keys)
        assertEquals("a new body", changes.captured["bodyCopy"])
        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
    }

    // ── THE FAILED RESUME-READ, the defect that needs no second editor ───────

    /**
     * THE WORST OF THE TWO, because the casualty is the auntie's own written work
     * and nothing anywhere reports it.
     *
     * `load` used to resume an existing draft with
     * `getKinCareReport(id).getOrNull() ?: scaffoldReport(session, template)`. A
     * transient read failure - offline on a driveway, a permission blip, a timeout -
     * fell through to a BLANK scaffold carrying the same session prefill. The screen
     * rendered an empty editor over a real report. The first content change then
     * persisted it, and a half-written KinTale was replaced by an empty one.
     *
     * A failed read is now distinguishable from a genuinely new draft, and a report
     * whose read failed is not saveable at all: the write is refused out loud and
     * the screen offers a retry.
     */
    @Test
    fun `a failed resume-read never overwrites the real KinTale with a blank one`() =
        runTest(testDispatcher) {
            coEvery { kinCareRepo.getKinCareReport("rep-1") } returns
                Result.failure(RuntimeException("UNAVAILABLE: network"))
            val vm = buildViewModel()
            vm.load("ses1", "rep-1")
            advanceUntilIdle()

            // The screen must say so rather than present a working blank editor.
            assertTrue("a failed resume-read must be visible", vm.uiState.value.reportLoadFailed)
            assertNotNull(vm.uiState.value.error)

            // And the report must not be saveable over the real record, by any path.
            vm.updateBodyCopy("typed into what looked like a fresh draft")
            vm.persistDraft()
            advanceUntilIdle()

            coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
            coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
        }

    /**
     * A reportId that points at no document is not a new draft either. Resuming a
     * deleted or mistyped id used to scaffold a blank report and then CREATE a
     * second one on first content change, orphaning it against the same session.
     */
    @Test
    fun `resuming a report id that no longer exists is refused rather than scaffolded`() =
        runTest(testDispatcher) {
            coEvery { kinCareRepo.getKinCareReport("rep-1") } returns Result.success(null)
            val vm = buildViewModel()
            vm.load("ses1", "rep-1")
            advanceUntilIdle()

            assertTrue(vm.uiState.value.reportLoadFailed)
            assertNotNull(vm.uiState.value.error)

            vm.updateBodyCopy("typed into what looked like a fresh draft")
            vm.persistDraft()
            advanceUntilIdle()

            coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
            coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        }

    /** The retry is a real retry: a load that succeeds second time restores the draft. */
    @Test
    fun `retrying a failed resume-read restores the real draft and re-enables saving`() =
        runTest(testDispatcher) {
            coEvery { kinCareRepo.getKinCareReport("rep-1") } returns
                Result.failure(RuntimeException("UNAVAILABLE: network"))
            val vm = buildViewModel()
            vm.load("ses1", "rep-1")
            advanceUntilIdle()
            assertTrue(vm.uiState.value.reportLoadFailed)

            coEvery { kinCareRepo.getKinCareReport("rep-1") } returns Result.success(stored)
            val changes = captureChanges()
            vm.retryLoad()
            advanceUntilIdle()

            assertFalse(vm.uiState.value.reportLoadFailed)
            assertEquals(stored.bodyCopy, vm.uiState.value.report.bodyCopy)

            vm.updateBodyCopy("now it is safe to type")
            vm.persistDraft()
            advanceUntilIdle()
            assertEquals(setOf("bodyCopy"), changes.captured.keys)
        }

    // ── a genuinely new draft still behaves as it did ────────────────────────

    /**
     * The Q3 ruling stands: a new KinTale is scaffolded IN MEMORY and reaches
     * Firestore only on the first content change. Nothing here may start creating
     * ghost documents for KinTales nobody wrote.
     */
    @Test
    fun `a new draft is not created until there is content`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.persistDraft()
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
        assertFalse(vm.uiState.value.reportLoadFailed)

        vm.updateBodyCopy("Biscuit had a lovely walk.")
        vm.persistDraft()
        advanceUntilIdle()

        coVerify(exactly = 1) { kinCareRepo.createKinCareReport(any()) }
    }

    /**
     * After the create, the baseline is what was just created - so the very next
     * save diffs against it rather than re-sending the whole freshly created report.
     */
    @Test
    fun `the save after a create writes only what changed since the create`() =
        runTest(testDispatcher) {
            val changes = captureChanges()
            val vm = buildViewModel()
            vm.load("ses1", null)
            advanceUntilIdle()

            vm.updateBodyCopy("Biscuit had a lovely walk.")
            vm.persistDraft()
            advanceUntilIdle()

            vm.updateTitle("A lovely walk")
            vm.persistDraft()
            advanceUntilIdle()

            assertEquals(setOf("title"), changes.captured.keys)
        }

    /**
     * A create that the server rejected leaves no id behind, so the next save must
     * try the create again rather than patching a document that does not exist.
     */
    @Test
    fun `a rejected create is retried as a create, not as a patch`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.createKinCareReport(any()) } returns Result.failure(RuntimeException("denied"))
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit had a lovely walk.")
        vm.persistDraft()
        advanceUntilIdle()
        assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)

        coEvery { kinCareRepo.createKinCareReport(any()) } returns Result.success("rep-new")
        vm.persistDraft()
        advanceUntilIdle()

        coVerify(exactly = 2) { kinCareRepo.createKinCareReport(any()) }
        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
    }

    // ── send ─────────────────────────────────────────────────────────────────

    /**
     * `send` used to swallow its pre-send save with `.getOrNull()`, so a rejected
     * save was followed by a notification announcing content the server never took.
     * The send now aborts and says so.
     */
    @Test
    fun `a send whose pre-save is rejected does not notify`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.updateKinCareReportFields(any(), any()) } returns
            Result.failure(RuntimeException("Write denied"))
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("the final wording")
        vm.send()
        advanceUntilIdle()

        coVerify(exactly = 0) { notifier.notify(any(), any(), any(), any()) }
        assertFalse(vm.uiState.value.sentSuccessfully)
        assertNotNull(vm.uiState.value.error)
    }
}
