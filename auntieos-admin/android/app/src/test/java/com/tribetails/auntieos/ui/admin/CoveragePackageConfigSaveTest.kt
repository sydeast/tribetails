package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.CoveragePackageConfig
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.DEFAULT_DURATIONS
import com.tribetails.auntieos.domain.Duration
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
 * Every visit-menu save writes a DIFF against the copy Firestore handed over, not
 * the model the screen is holding.
 *
 * `coverage_package_config/config` is one operator-global document with two
 * writers: this screen and the React Coverage Package Builder, which persists
 * `{ durations, updatedAt, updatedBy }` (`api/coveragePackageWrite.ts`). The
 * android side used to hand it `.set(wholeModel, merge())` - the shape #312, #315
 * and #327 removed from their own collections.
 *
 * TWO KINDS OF TEST LIVE HERE, and only the second kind is load-bearing. "The
 * edited menu was written" passes on the broken code too and proves nothing. What
 * the broken code fails is: a save that changed nothing must not write, and a save
 * with no successfully loaded baseline must not write at all.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CoveragePackageConfigSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    /** The document as it stood when the phone read it - last touched on the web. */
    private val stored = CoveragePackageConfig(
        durations = DEFAULT_DURATIONS,
        updatedAt = "2026-01-01T00:00:00Z",
        updatedBy = "web@tribetails.com",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getCoveragePackageConfig() } returns Result.success(stored)
        coEvery { repo.updateCoveragePackageConfigFields(any(), any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun captureChanges(): CapturingSlot<Map<String, Any?>> {
        val changes = slot<Map<String, Any?>>()
        coEvery { repo.updateCoveragePackageConfigFields(capture(changes), any()) } returns Result.success(Unit)
        return changes
    }

    private fun loadedViewModel(): CoveragePackageViewModel {
        val vm = CoveragePackageViewModel(repository = repo)
        vm.loadConfig()
        return vm
    }

    private val editedMenu = DEFAULT_DURATIONS + Duration("d9", "3-hour visit", 180.0, 95.0, "visit")

    @Test
    fun `a save writes the edited menu and nothing else`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel()

        vm.saveConfig(editedMenu)
        advanceUntilIdle()

        assertEquals(setOf("durations"), changes.captured.keys)
        assertEquals(editedMenu, changes.captured["durations"])
        assertTrue(vm.uiState.value.saveSuccess)
        assertNull(vm.uiState.value.error)
    }

    /**
     * THE CONCURRENT-EDIT CASE, at the only granularity this document has.
     *
     * An operator opens the Coverage Package Builder on the phone. While it sits
     * there, someone adds a 3-hour visit to the menu in the React admin, so the
     * server's `durations` no longer match the phone's copy. The operator then
     * presses Save without having changed the menu.
     *
     * The write must not happen. On the old code it did: the whole model went out,
     * so the phone's stale menu replaced the web's, and `updatedAt` moved to claim
     * a change that never happened. "Saved" and "nothing to save" are the same
     * outcome to the operator, so the screen still reports success.
     *
     * Unreachable from the current UI, where the Save button is gated on
     * `durations != config.durations` - the same posture as the Business Operations
     * panel #327 fixed, where the control WAS reachable. The ViewModel is the
     * contract, and a screen-level guard is not one.
     */
    @Test
    fun `a save that changed nothing writes nothing, not even the stamp`() = runTest(testDispatcher) {
        val vm = loadedViewModel()

        vm.saveConfig(stored.durations)
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateCoveragePackageConfigFields(any(), any()) }
        assertTrue("a save with nothing to save still reports success", vm.uiState.value.saveSuccess)
        assertNull(vm.uiState.value.error)
    }

    /**
     * THE UNCONDITIONAL LOSS, the one that needs no second editor at all - #327's
     * `EnhancedSchedulingViewModel` find, one collection over.
     *
     * `CoveragePackageUiState.config` starts at `CoveragePackageConfig()`, an EMPTY
     * menu. When the load fails the screen shows its error banner but the visit
     * menu editor still works off that empty config, and the panel's own "Defaults"
     * button fills it with `DEFAULT_DURATIONS` and enables Save. That save used to
     * write the shipped defaults straight over the operator's real priced menu,
     * having never read it.
     *
     * The baseline is null until a load SUCCEEDS, and a save with no baseline is
     * refused out loud rather than absorbed.
     */
    @Test
    fun `a save after a failed load is refused instead of overwriting the real menu`() =
        runTest(testDispatcher) {
            coEvery { repo.getCoveragePackageConfig() } returns
                Result.failure(RuntimeException("permission-denied"))
            val vm = CoveragePackageViewModel(repository = repo)
            vm.loadConfig()
            advanceUntilIdle()

            vm.saveConfig(DEFAULT_DURATIONS)
            advanceUntilIdle()

            coVerify(exactly = 0) { repo.updateCoveragePackageConfigFields(any(), any()) }
            assertFalse(vm.uiState.value.saveSuccess)
            assertNotNull(vm.uiState.value.error)
        }

    /** Never loaded at all is the same refusal as loaded-and-failed. */
    @Test
    fun `a save with no load at all is refused`() = runTest(testDispatcher) {
        val vm = CoveragePackageViewModel(repository = repo)

        vm.saveConfig(DEFAULT_DURATIONS)
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateCoveragePackageConfigFields(any(), any()) }
        assertFalse(vm.uiState.value.saveSuccess)
        assertNotNull(vm.uiState.value.error)
    }

    /**
     * The baseline advances to what the server now holds. Without it a second save
     * re-sends the first save's menu, which is the same clobber one step later.
     */
    @Test
    fun `a second save of the same menu writes nothing`() = runTest(testDispatcher) {
        val vm = loadedViewModel()

        vm.saveConfig(editedMenu)
        advanceUntilIdle()
        vm.saveConfig(editedMenu)
        advanceUntilIdle()

        coVerify(exactly = 1) { repo.updateCoveragePackageConfigFields(any(), any()) }
        assertTrue(vm.uiState.value.saveSuccess)
    }

    /**
     * The baseline advances only after a write the SERVER accepted, so a rejected
     * save leaves the edit pending and the retry still carries it.
     */
    @Test
    fun `a rejected save leaves the edit pending for the retry`() = runTest(testDispatcher) {
        val changes = slot<Map<String, Any?>>()
        coEvery { repo.updateCoveragePackageConfigFields(capture(changes), any()) } returns
            Result.failure(RuntimeException("Write denied"))
        val vm = loadedViewModel()

        vm.saveConfig(editedMenu)
        advanceUntilIdle()
        assertFalse(vm.uiState.value.saveSuccess)
        assertNotNull(vm.uiState.value.error)

        coEvery { repo.updateCoveragePackageConfigFields(capture(changes), any()) } returns Result.success(Unit)
        vm.saveConfig(editedMenu)
        advanceUntilIdle()

        assertEquals(setOf("durations"), changes.captured.keys)
        assertEquals(editedMenu, changes.captured["durations"])
        assertTrue(vm.uiState.value.saveSuccess)
    }

    /**
     * The stamps the phone read must never ride along in the write. They are the
     * one pair of fields a whole-model write got right by accident - it overwrote
     * them - and the one pair a naive diff would get wrong by sending the stale
     * values it read.
     */
    @Test
    fun `the stamps the phone read are never part of the write`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel()

        vm.saveConfig(editedMenu)
        advanceUntilIdle()

        assertFalse("stale updatedAt in the write: ${changes.captured}", changes.captured.containsKey("updatedAt"))
        assertFalse("stale updatedBy in the write: ${changes.captured}", changes.captured.containsKey("updatedBy"))
        assertFalse("document id in the write: ${changes.captured}", changes.captured.containsKey("id"))
    }
}
