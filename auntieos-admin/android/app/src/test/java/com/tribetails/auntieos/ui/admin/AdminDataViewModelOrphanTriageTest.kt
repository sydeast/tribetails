package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Orchestration tests for the orphan-triage flows on AdminDataViewModel.
 *
 * The underlying Firestore writes in AuntieRepository can't be exercised in
 * pure-JVM (no Firebase emulator wired into these tests), so the contract we
 * lock down here is the ViewModel layer:
 *   • success path publishes a positive TriageResult and reloads reports
 *   • failure path publishes an error TriageResult and clears the loading flag
 *   • clearTriageResult() drops the toast state
 *
 * This mirrors the pure-helper TDD pattern already used elsewhere in the repo
 * (see KinCareRepositoryBreadcrumbsTest's comment block).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminDataViewModelOrphanTriageTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockKinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockKinCareRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = AdminDataViewModel(repository = mockRepo, invoiceRepository = mockk(relaxed = true), kinCareRepository = mockKinCareRepo)

    // ─── loadKinfolkDirectory ─────────────────────────────────────────────────

    @Test
    fun `loadKinfolkDirectory populates and sorts kinfolk by name`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinfolk() } returns Result.success(
            listOf(TestFixtures.kinfolk2, TestFixtures.kinfolk1) // Jane, Rosa - unsorted
        )

        val vm = buildViewModel()
        vm.loadKinfolkDirectory()
        advanceUntilIdle()

        val names = vm.kinfolkDirectory.value.map { it.firstName }
        // Alphabetical by "${firstName} ${lastName}" lowercase → Jane Doe, Rosa Parks
        assertEquals(listOf("Jane", "Rosa"), names)
    }

    @Test
    fun `loadKinfolkDirectory sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinfolk() } returns Result.failure(RuntimeException("perm denied"))

        val vm = buildViewModel()
        vm.loadKinfolkDirectory()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertTrue(vm.error.value!!.contains("perm denied"))
    }

    // ─── assignOrphanReport ───────────────────────────────────────────────────

    @Test
    fun `assignOrphanReport on success publishes success result and reloads reports`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.assignKinfolkToOrphanReport("legacy_79", "kf1", "Rosa Parks") } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.assignOrphanReport("legacy_79", "kf1", "Rosa Parks")
        advanceUntilIdle()

        val result = vm.triageResult.value
        assertNotNull(result)
        assertTrue(result!!.success)
        assertTrue(result.message.contains("Rosa Parks"))
        coVerify { mockKinCareRepo.getAllKinCareReports() }
    }

    @Test
    fun `assignOrphanReport on failure publishes error result and clears isLoading`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.assignKinfolkToOrphanReport(any(), any(), any()) } returns Result.failure(RuntimeException("write denied"))

        val vm = buildViewModel()
        vm.assignOrphanReport("legacy_79", "kf1", "Rosa Parks")
        advanceUntilIdle()

        val result = vm.triageResult.value
        assertNotNull(result)
        assertFalse(result!!.success)
        assertTrue(result.message.contains("write denied"))
        assertFalse(vm.isLoading.value)
    }

    // ─── markOrphanAsDuplicate ────────────────────────────────────────────────

    @Test
    fun `markOrphanAsDuplicate on success publishes success result and reloads`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.markOrphanReportAsDuplicate("legacy_80", "report_xyz") } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.markOrphanAsDuplicate("legacy_80", "report_xyz")
        advanceUntilIdle()

        val result = vm.triageResult.value
        assertNotNull(result)
        assertTrue(result!!.success)
        assertEquals("Marked as duplicate", result.message)
        coVerify { mockKinCareRepo.getAllKinCareReports() }
    }

    @Test
    fun `markOrphanAsDuplicate on failure surfaces error message`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.markOrphanReportAsDuplicate(any(), any()) } returns Result.failure(IllegalArgumentException("Cannot mark a report as a duplicate of itself"))

        val vm = buildViewModel()
        vm.markOrphanAsDuplicate("legacy_80", "legacy_80")
        advanceUntilIdle()

        val result = vm.triageResult.value
        assertNotNull(result)
        assertFalse(result!!.success)
        assertTrue(result.message.contains("duplicate of itself"))
        assertFalse(vm.isLoading.value)
    }

    // ─── archiveOrphanAsBad ───────────────────────────────────────────────────

    @Test
    fun `archiveOrphanAsBad on success publishes success result and reloads`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.archiveOrphanReportAsBadData("legacy_81", "junk test data") } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.archiveOrphanAsBad("legacy_81", "junk test data")
        advanceUntilIdle()

        val result = vm.triageResult.value
        assertNotNull(result)
        assertTrue(result!!.success)
        assertEquals("Archived as bad data", result.message)
        coVerify { mockKinCareRepo.getAllKinCareReports() }
    }

    @Test
    fun `archiveOrphanAsBad on failure surfaces repo error and clears isLoading`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.archiveOrphanReportAsBadData(any(), any()) } returns Result.failure(IllegalArgumentException("Archive reason must be at least 5 characters"))

        val vm = buildViewModel()
        vm.archiveOrphanAsBad("legacy_81", "no")
        advanceUntilIdle()

        val result = vm.triageResult.value
        assertNotNull(result)
        assertFalse(result!!.success)
        assertTrue(result.message.contains("at least 5"))
        assertFalse(vm.isLoading.value)
    }

    // ─── clearTriageResult ────────────────────────────────────────────────────

    @Test
    fun `clearTriageResult drops the toast state`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.archiveOrphanReportAsBadData(any(), any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.archiveOrphanAsBad("legacy_81", "junk test data")
        advanceUntilIdle()
        assertNotNull(vm.triageResult.value)

        vm.clearTriageResult()
        assertNull(vm.triageResult.value)
    }

    // ─── reload pipeline preserves report data shape ──────────────────────────

    @Test
    fun `successful triage triggers report reload which repopulates state`() = runTest(testDispatcher) {
        val reportAfter = KinCareReport(id = "legacy_79").also {
            it.kinfolkId = "kf1"
            it.kinfolkName = "Rosa Parks"
            it.sentVia = "legacy_visit_logs"
            it.triageStatus = "assigned"
        }
        coEvery { mockKinCareRepo.assignKinfolkToOrphanReport(any(), any(), any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getAllKinCareReports() } returns Result.success(listOf(reportAfter))

        val vm = buildViewModel()
        vm.assignOrphanReport("legacy_79", "kf1", "Rosa Parks")
        advanceUntilIdle()

        assertEquals(1, vm.kinCareReports.value.size)
        assertEquals("assigned", vm.kinCareReports.value.first().triageStatus)
    }
}
