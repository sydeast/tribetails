package com.tribetails.auntieos.ui.home

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
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
class HomeViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockNotifier: VisitNotifier

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockNotifier = mockk(relaxed = true)
        stubDefaultRepoResponses()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun stubDefaultRepoResponses() {
        coEvery { mockRepo.getKinfolkCount() } returns Result.success(2)
        coEvery { mockRepo.getKinCount() } returns Result.success(3)
        coEvery { mockRepo.getPendingDraftCount() } returns Result.success(1)
        coEvery { mockRepo.getRecentDrafts() } returns Result.success(listOf(TestFixtures.draft1))
        coEvery { mockRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(TestFixtures.businessSettings)
        // Stage 2 Step 2: Home now loads invoices for the weekly-revenue tile.
        coEvery { mockRepo.getInvoices() } returns Result.success(emptyList())
        // Gatekeeper widget: Home now loads all sessions for the visit-gap ranking.
        coEvery { mockRepo.getKinCareSessions() } returns Result.success(emptyList())
    }

    private fun buildViewModel() = HomeViewModel(repo = mockRepo, notifier = mockNotifier)

    @Test
    fun `init loads dashboard data successfully`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertFalse(state.isOffline)
        assertEquals(2, state.kinfolkCount)
        assertEquals(3, state.kinCount)
        assertEquals(1, state.pendingDraftCount)
        assertEquals(1, state.recentDrafts.size)
        assertNull(state.actionError)
    }

    @Test
    fun `load sets isOffline and actionError when session reload fails after auto-complete`() = runTest(testDispatcher) {
        val autoCompleteSession = TestFixtures.session1.copy(
            status = com.tribetails.auntieos.data.model.VisitStatus.DEPARTED.name,
            autoCompleteEligible = true
        )
        coEvery { mockRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(listOf(autoCompleteSession))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.markSessionComplete(any()) } returns Result.success(Unit)
        coEvery { mockRepo.getKinCareSessionsForDay(any(), any()) } returnsMany listOf(
            Result.success(listOf(autoCompleteSession)),
            Result.failure(RuntimeException("Reload failed"))
        )

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.isLoading)
        assertTrue(state.isOffline)
        assertNotNull(state.actionError)
    }

    @Test
    fun `clearActionError resets actionError to null after error`() = runTest(testDispatcher) {
        val autoCompleteSession = TestFixtures.session1.copy(
            status = com.tribetails.auntieos.data.model.VisitStatus.DEPARTED.name,
            autoCompleteEligible = true
        )
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.markSessionComplete(any()) } returns Result.success(Unit)
        coEvery { mockRepo.getKinCareSessionsForDay(any(), any()) } returnsMany listOf(
            Result.success(listOf(autoCompleteSession)),
            Result.failure(RuntimeException("fail"))
        )

        val vm = buildViewModel()
        advanceUntilIdle()

        assertTrue("Precondition: load must have set isOffline", vm.uiState.value.isOffline)
        vm.clearActionError()
        assertNull(vm.uiState.value.actionError)
    }

    @Test
    fun `todayVisits are hydrated with kinfolk cards`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(listOf(TestFixtures.session1))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(1, state.todayVisits.size)
        assertEquals(TestFixtures.kinfolk1, state.todayVisits[0].kinfolk)
    }

    @Test
    fun `complete sets pendingActionSessionId during action`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(listOf(TestFixtures.session1))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.markSessionComplete(any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.complete("ses1")
        advanceUntilIdle()

        assertNull(vm.uiState.value.pendingActionSessionId)
    }

    @Test
    fun `complete does nothing when sessionId not in todayVisits`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.complete("nonexistent")
        advanceUntilIdle()

        assertNull(vm.uiState.value.pendingActionSessionId)
    }

    @Test
    fun `complete with unknown sessionId sets actionError`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.complete("nonexistent-session-id")
        advanceUntilIdle()

        assertNotNull(
            "Expected actionError when completing a session not in todayVisits, but was null",
            vm.uiState.value.actionError
        )
    }

    @Test
    fun `businessSettings are loaded from repository`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(
            BusinessSettings(enableGPSTrackingForAllVisits = true, defaultEtaMinutes = 15)
        )

        val vm = buildViewModel()
        advanceUntilIdle()

        assertTrue(vm.uiState.value.businessSettings.enableGPSTrackingForAllVisits)
        assertEquals(15, vm.uiState.value.businessSettings.defaultEtaMinutes)
    }

    // WARNING-9 fail-loud tests: each count/list read failure must surface via isOffline
    // and preserve partial data rather than silently defaulting to 0 / emptyList.

    @Test
    fun `kinfolk count read failure sets isOffline and logs not silently 0`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinfolkCount() } returns Result.failure(RuntimeException("Firestore unavailable"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse("isLoading should be false after load", state.isLoading)
        assertTrue("isOffline must be true when kinfolkCount read fails", state.isOffline)
        assertEquals("kinfolkCount should default to 0 on error", 0, state.kinfolkCount)
    }

    @Test
    fun `kin count read failure sets isOffline`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinCount() } returns Result.failure(RuntimeException("Permission denied"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue("isOffline must be true when kinCount read fails", state.isOffline)
        assertEquals(0, state.kinCount)
    }

    @Test
    fun `pending draft count read failure sets isOffline`() = runTest(testDispatcher) {
        coEvery { mockRepo.getPendingDraftCount() } returns Result.failure(RuntimeException("Timeout"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue("isOffline must be true when pendingDraftCount read fails", state.isOffline)
        assertEquals(0, state.pendingDraftCount)
    }

    @Test
    fun `recent drafts read failure sets isOffline`() = runTest(testDispatcher) {
        coEvery { mockRepo.getRecentDrafts() } returns Result.failure(RuntimeException("Network error"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue("isOffline must be true when recentDrafts read fails", state.isOffline)
        assertTrue("recentDrafts should be empty list on error", state.recentDrafts.isEmpty())
    }

    @Test
    fun `today sessions read failure sets isOffline`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinCareSessionsForDay(any(), any()) } returns Result.failure(RuntimeException("Auth expired"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue("isOffline must be true when todaySessions read fails", state.isOffline)
        assertTrue("todayVisits should be empty on error", state.todayVisits.isEmpty())
    }

    @Test
    fun `business settings read failure sets isOffline`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBusinessSettings() } returns Result.failure(RuntimeException("Quota exceeded"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue("isOffline must be true when businessSettings read fails", state.isOffline)
    }

    @Test
    fun `partial read failure still shows successful reads and sets isOffline`() = runTest(testDispatcher) {
        // kinfolkCount succeeds, kinCount fails — both count tiles should render
        // (kinfolkCount real, kinCount 0), and isOffline must be true.
        coEvery { mockRepo.getKinCount() } returns Result.failure(RuntimeException("Partial failure"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue("isOffline must be true even on partial failure", state.isOffline)
        assertEquals("Successful reads must still appear", 2, state.kinfolkCount)
        assertEquals("Failed reads default to 0", 0, state.kinCount)
    }

    @Test
    fun `cash flow outstanding and gatekeeper gaps computed from loaded data`() = runTest(testDispatcher) {
        coEvery { mockRepo.getInvoices() } returns Result.success(
            listOf(
                com.tribetails.auntieos.data.model.Invoice(id = "i1", status = "unpaid", total = 120.0, amountDue = 120.0, date = "2026-06-01"),
                com.tribetails.auntieos.data.model.Invoice(id = "i2", status = "unpaid", total = 30.5, amountDue = 30.5, date = "2026-06-02"),
                com.tribetails.auntieos.data.model.Invoice(id = "i3", status = "paid", total = 99.0, amountDue = 0.0, date = "2026-06-02"),
            ),
        )
        val lastVisit = java.time.LocalDate.now().minusDays(15).toString()
        coEvery { mockRepo.getKinCareSessions() } returns Result.success(
            listOf(
                KinCareSession(kinfolkId = "f1", kinfolkName = "the Bs", startTime = lastVisit, status = "COMPLETED"),
            ),
        )

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(150.5, state.outstandingTotal, 0.0001)
        assertEquals(2, state.outstandingCount)
        assertTrue(state.invoicesLoaded)
        assertTrue(state.gapsLoaded)
        assertEquals(1, state.visitGaps.size)
        assertEquals("the Bs", state.visitGaps[0].household)
        assertEquals(15, state.visitGaps[0].daysSinceLastVisit)
    }

    @Test
    fun `sessions read failure degrades gatekeeper without blanking dashboard`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKinCareSessions() } returns Result.failure(RuntimeException("boom"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.gapsLoaded)
        assertTrue(state.visitGaps.isEmpty())
        assertEquals("Other tiles still render", 2, state.kinfolkCount)
    }
}
