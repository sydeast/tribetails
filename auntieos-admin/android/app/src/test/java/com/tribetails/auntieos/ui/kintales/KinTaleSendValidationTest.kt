package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The draft rules as the COMPOSER applies them (#552): live on the field, and at
 * the send boundary, but never in the way of a save.
 *
 * `KinTaleDraftValidationTest` pins the rules themselves. This pins where they
 * bite: the outward-facing action, which is the one that cannot be taken back.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleSendValidationTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private lateinit var uploader: MediaUploadManager
    private lateinit var notifier: VisitNotifier

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        kinCareRepo = mockk()
        uploader = mockk(relaxed = true)
        notifier = mockk(relaxed = true)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun buildViewModel() = KinTaleReportViewModel(
        repository = repo,
        kinCareRepository = kinCareRepo,
        mediaUploader = uploader,
        notifier = notifier,
    )

    private fun stubLoad() {
        coEvery { kinCareRepo.getKinCareSession("ses1") } returns Result.success(TestFixtures.session1)
        coEvery { repo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { repo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { repo.getActiveTemplateForService(any()) } returns Result.success(null)
        coEvery { repo.getMediaFiles(any(), any()) } returns Result.success(emptyList())
        // The editor autosaves what is typed, so the create is on the path of
        // every one of these tests whether or not they are about saving.
        coEvery { kinCareRepo.createKinCareReport(any()) } returns Result.success("rep-1")
        coEvery { kinCareRepo.updateKinCareReportFields(any(), any()) } returns Result.success(Unit)
    }

    @Test
    fun `a dash in the headline surfaces on the field, not only at send time`() = runTest(testDispatcher) {
        stubLoad()
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("Biscuit — the best boy")
        advanceUntilIdle()

        assertEquals(
            "Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses.",
            vm.uiState.value.titleError,
        )
        assertNotNull(vm.uiState.value.sendBlocker)
    }

    @Test
    fun `send refuses a draft that breaks a rule, and never reaches the notifier`() = runTest(testDispatcher) {
        stubLoad()
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("We walked to the river — twice.")
        advanceUntilIdle()
        vm.send()
        advanceUntilIdle()

        assertEquals(
            "Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses.",
            vm.uiState.value.error,
        )
        // The kinfolk is not told about a KinTale the rules refused.
        coVerify(exactly = 0) { notifier.notify(any(), any()) }
        coVerify(exactly = 0) { kinCareRepo.markReportSent(any(), any(), any(), any()) }
    }

    @Test
    fun `a broken draft still SAVES, because a draft is allowed to be unfinished`() = runTest(testDispatcher) {
        stubLoad()
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateBodyCopy("Half a thought — finish later.")
        advanceUntilIdle()
        vm.persistDraft()
        advanceUntilIdle()

        coVerify(atLeast = 1) { kinCareRepo.createKinCareReport(any()) }
        assertEquals(SaveStatus.SAVED, vm.uiState.value.saveStatus)
    }

    @Test
    fun `a clean draft has no blocker and Send is free to run`() = runTest(testDispatcher) {
        stubLoad()
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("A great day at the park")
        vm.updateBodyCopy("Biscuit chased every duck in the county, then slept.")
        advanceUntilIdle()

        assertNull(vm.uiState.value.titleError)
        assertNull(vm.uiState.value.bodyError)
        assertNull(vm.uiState.value.sendBlocker)
    }

    @Test
    fun `an overlong headline blocks Send with the length message`() = runTest(testDispatcher) {
        stubLoad()
        val vm = buildViewModel()
        vm.load("ses1", null)
        advanceUntilIdle()

        vm.updateTitle("a".repeat(KIN_TALE_TITLE_MAX + 1))
        advanceUntilIdle()
        vm.send()
        advanceUntilIdle()

        assertEquals("Keep the headline under 120 characters.", vm.uiState.value.error)
        coVerify(exactly = 0) { notifier.notify(any(), any()) }
    }
}
