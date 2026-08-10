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
 * The KinTale draft saves itself while the sitter writes, and says so honestly.
 *
 * ONE MECHANISM REACHES FIRESTORE. `persistDraft` was already called on blur, on
 * section change, on every toggle and mood pick, on media add/remove, on Back and
 * on Save Draft. The autosave is a DEBOUNCE TIMER in front of that same method,
 * not a second write path - so the three triggers cannot fight, and everything the
 * safety change put on `persistDraft` (the field diff, the empty-write skip, the
 * refusal after a failed read) applies to the autosave for free.
 *
 * WHAT THE BROKEN-CODE-PASSES TRAP LOOKS LIKE HERE: "a write happened after
 * typing" would pass on a naive per-keystroke save too. The load-bearing cases are
 * that NOTHING is written before the pause completes, that a burst of typing
 * collapses to ONE write, that a blur cancels the pending timer instead of
 * doubling it, and that a failed autosave never tells the sitter their work is
 * safe.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleAutosaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private lateinit var uploader: MediaUploadManager
    private lateinit var notifier: VisitNotifier

    /** A clock the test drives, so "when did it last save" is asserted, not guessed. */
    private var clock = 1_000_000L

    private val stored = KinCareReport(
        id = "rep-1",
        sessionId = "ses1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        title = "Biscuit's afternoon",
        bodyCopy = "Biscuit met the neighbour's cat.",
        status = ReportStatus.DRAFT.name,
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
        now = { clock },
    )

    private fun captureChanges(): CapturingSlot<Map<String, Any?>> {
        val changes = slot<Map<String, Any?>>()
        coEvery { kinCareRepo.updateKinCareReportFields(any(), capture(changes)) } returns Result.success(Unit)
        return changes
    }

    private fun resumedViewModel(): KinTaleReportViewModel {
        val vm = buildViewModel()
        vm.load("ses1", "rep-1")
        return vm
    }

    /** One millisecond short of the debounce, then over it. */
    private fun kotlinx.coroutines.test.TestScope.almostPause() =
        advanceTimeBy(KinTaleReportViewModel.AUTOSAVE_DEBOUNCE_MS - 1)

    private fun kotlinx.coroutines.test.TestScope.completePause() = advanceTimeBy(2)

    // ── when it fires ────────────────────────────────────────────────────────

    /**
     * NOTHING IS WRITTEN WHILE THE SITTER IS STILL TYPING. A per-keystroke save
     * would pass "a write happened after typing"; it fails this.
     */
    @Test
    fun `typing alone writes nothing until the sitter stops`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit met")
        vm.updateBodyCopy("Biscuit met the cat")
        vm.updateBodyCopy("Biscuit met the cat and made a friend")
        almostPause()

        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        assertTrue("the sitter must be told the work is not saved yet", vm.uiState.value.hasUnsavedChanges)
    }

    /** A whole burst of typing collapses to exactly one write once the pause completes. */
    @Test
    fun `a burst of typing collapses to one write after the pause`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit met")
        vm.updateBodyCopy("Biscuit met the cat")
        vm.updateBodyCopy("Biscuit met the cat and made a friend")
        almostPause()
        completePause()

        coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        assertEquals(setOf("bodyCopy"), changes.captured.keys)
        assertEquals("Biscuit met the cat and made a friend", changes.captured["bodyCopy"])
        assertFalse(vm.uiState.value.hasUnsavedChanges)
    }

    /** The headline autosaves on the same timer as the body. */
    @Test
    fun `the headline autosaves too`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateTitle("Biscuit's big afternoon")
        almostPause()
        completePause()

        assertEquals(setOf("title"), changes.captured.keys)
    }

    /**
     * Free-text template fields and Phase-14 custom-field answers are written work
     * too. `setStringField` saved only on blur and `updateFormValue` only on an
     * explicit save; both now ride the same timer. This is a deliberate behavior
     * change, not a side effect.
     */
    @Test
    fun `free-text template fields and custom-field answers autosave`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.setStringField("water", "kin1", "topped up twice")
        almostPause()
        completePause()
        assertEquals(setOf("fieldResponses"), changes.captured.keys)

        vm.updateFormValue("gate_latched", "yes")
        almostPause()
        completePause()
        assertEquals(setOf("formValues"), changes.captured.keys)
    }

    // ── how it interacts with the persists that already existed ──────────────

    /**
     * A BLUR CANCELS THE PENDING TIMER RATHER THAN DOUBLING IT. Blur already
     * persisted; stacking a timer on top would write the same edit twice, once on
     * blur and once when the timer expired. One edit, one write.
     */
    @Test
    fun `a blur saves immediately and cancels the pending autosave`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit met the cat and made a friend")
        almostPause()
        vm.persistDraft() // the blur
        advanceUntilIdle()

        coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }

        // The timer that was already running must not fire a second write.
        completePause()
        advanceUntilIdle()
        coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }
    }

    /**
     * A section change - a checklist toggle - persists immediately as it always
     * did, and the pending text timer folds into that same write rather than
     * following it with a second one.
     */
    @Test
    fun `a toggle persists immediately and carries the pending text edit with it`() =
        runTest(testDispatcher) {
            val changes = captureChanges()
            val vm = resumedViewModel()
            advanceUntilIdle()

            vm.updateBodyCopy("Biscuit met the cat")
            almostPause()
            vm.setChecklistResponse("fed", "kin1", true)
            advanceUntilIdle()

            coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }
            assertEquals(setOf("bodyCopy", "fieldResponses"), changes.captured.keys)

            completePause()
            advanceUntilIdle()
            coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        }

    /**
     * The pause after an edit that was already saved writes nothing. Without the
     * empty-diff skip the safety change added, an idle timer would move `updatedAt`
     * on a document nothing had changed.
     */
    @Test
    fun `the timer firing after an identical save writes nothing`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit met the cat")
        vm.persistDraft()
        advanceUntilIdle()
        coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }

        vm.updateBodyCopy("Biscuit met the cat") // retyped to the same value
        almostPause()
        completePause()

        coVerify(exactly = 1) { kinCareRepo.updateKinCareReportFields(any(), any()) }
    }

    // ── the Q3 ruling: no ghost documents ────────────────────────────────────

    /**
     * A KINTALE NOBODY WROTE NEVER REACHES FIRESTORE. Auntie's Q3 ruling is that a
     * draft is scaffolded in memory and persisted only on the first content change.
     * An autosave that fired on an empty scaffold would create a ghost document for
     * every visit whose KinTale screen was merely opened.
     */
    @Test
    fun `an untouched new draft is never created by the timer`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        almostPause()
        completePause()
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
    }

    /** Typing into a blank field and deleting it again is still nothing to save. */
    @Test
    fun `typing and erasing on a new draft creates nothing`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("oops")
        vm.updateBodyCopy("")
        almostPause()
        completePause()
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
    }

    /** The first real content on a new draft does create it, on the timer. */
    @Test
    fun `the first real content on a new draft is created by the timer`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("Biscuit had a lovely walk.")
        almostPause()
        completePause()
        advanceUntilIdle()

        coVerify(exactly = 1) { kinCareRepo.createKinCareReport(any()) }
        assertEquals("rep-new", vm.uiState.value.report.id)
    }

    // ── a draft that failed to load stays untouched ──────────────────────────

    /**
     * The autosave must never become a way around the failed-read refusal. A timer
     * ticking over a blank scaffold is exactly the continuous version of the bug
     * the safety change fixed.
     */
    @Test
    fun `no timer runs over a KinTale whose read failed`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getKinCareReport("rep-1") } returns
            Result.failure(RuntimeException("UNAVAILABLE: network"))
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("typed into what looked like a fresh draft")
        almostPause()
        completePause()
        advanceUntilIdle()

        coVerify(exactly = 0) { kinCareRepo.updateKinCareReportFields(any(), any()) }
        coVerify(exactly = 0) { kinCareRepo.createKinCareReport(any()) }
    }

    // ── what the sitter sees ─────────────────────────────────────────────────

    /**
     * A DRAFT THAT SAVES ITSELF MUST SAY WHEN IT LAST SUCCEEDED. "Draft saved" with
     * no time on it is the same reassurance whether the last write was two seconds
     * or two hours ago, and the sitter is being asked to trust it with work they
     * cannot see.
     */
    @Test
    fun `a successful autosave records when it happened`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()
        assertNull("nothing has been saved yet", vm.uiState.value.lastSavedAtMillis)

        clock = 1_700_000L
        vm.updateBodyCopy("Biscuit met the cat")
        almostPause()
        completePause()

        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
        assertEquals(1_700_000L, vm.uiState.value.lastSavedAtMillis)
        assertFalse(vm.uiState.value.hasUnsavedChanges)
    }

    /**
     * A SILENT AUTOSAVE THAT FAILS IS WORSE THAN NO AUTOSAVE, because the sitter
     * believes the work is safe. A rejected write must not move the saved-at stamp,
     * must not clear the unsaved marker, and must say so.
     */
    @Test
    fun `a failed autosave never claims the work is saved`() = runTest(testDispatcher) {
        val vm = resumedViewModel()
        advanceUntilIdle()

        clock = 1_700_000L
        vm.updateBodyCopy("the first burst")
        almostPause()
        completePause()
        assertEquals(1_700_000L, vm.uiState.value.lastSavedAtMillis)

        coEvery { kinCareRepo.updateKinCareReportFields(any(), any()) } returns
            Result.failure(RuntimeException("UNAVAILABLE: offline"))
        clock = 1_800_000L
        vm.updateBodyCopy("the second burst, written on a driveway with no signal")
        almostPause()
        completePause()

        assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)
        assertNotNull(vm.uiState.value.error)
        assertEquals(
            "a failed save must not move the saved-at stamp",
            1_700_000L,
            vm.uiState.value.lastSavedAtMillis,
        )
        assertTrue("the edit is still unsaved and must say so", vm.uiState.value.hasUnsavedChanges)
    }

    /**
     * AND THE CHANGE IS NOT DROPPED. The baseline never advanced, so the next
     * trigger - another pause, a blur, the Save Draft button - still carries the
     * text written while offline.
     */
    @Test
    fun `an edit written offline is still carried by the next successful save`() =
        runTest(testDispatcher) {
            coEvery { kinCareRepo.updateKinCareReportFields(any(), any()) } returns
                Result.failure(RuntimeException("UNAVAILABLE: offline"))
            val vm = resumedViewModel()
            advanceUntilIdle()

            vm.updateBodyCopy("written on a driveway with no signal")
            almostPause()
            completePause()
            assertEquals(SaveStatus.ERROR, vm.uiState.value.saveStatus)

            val changes = captureChanges()
            vm.updateBodyCopy("written on a driveway with no signal, then a bit more")
            almostPause()
            completePause()

            assertEquals(setOf("bodyCopy"), changes.captured.keys)
            assertEquals(
                "written on a driveway with no signal, then a bit more",
                changes.captured["bodyCopy"],
            )
            assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
            assertFalse(vm.uiState.value.hasUnsavedChanges)
        }

    /**
     * A save in flight does not swallow the keystrokes typed during it. The baseline
     * advances to the snapshot the write CARRIED, so text added meanwhile is still
     * pending afterwards and the next trigger sends it.
     */
    @Test
    fun `text typed during an in-flight save is not marked saved by it`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = resumedViewModel()
        advanceUntilIdle()

        vm.updateBodyCopy("the first sentence.")
        almostPause()
        completePause()
        assertEquals("the first sentence.", changes.captured["bodyCopy"])

        vm.updateBodyCopy("the first sentence. And a second.")
        assertTrue(vm.uiState.value.hasUnsavedChanges)
        almostPause()
        completePause()

        assertEquals("the first sentence. And a second.", changes.captured["bodyCopy"])
        assertFalse(vm.uiState.value.hasUnsavedChanges)
    }
}
