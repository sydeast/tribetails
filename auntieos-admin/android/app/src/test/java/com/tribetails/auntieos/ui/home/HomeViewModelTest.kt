package com.tribetails.auntieos.ui.home

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.domain.ArrivalCheckOutcome
import com.tribetails.auntieos.domain.ArrivalCheckStatus
import com.tribetails.auntieos.location.ArrivalFix
import com.tribetails.auntieos.location.ArrivalFixProvider
import com.tribetails.auntieos.notifications.VisitNotifier
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
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
    private lateinit var mockInvoiceRepo: InvoiceRepository
    private lateinit var mockKinCareRepo: KinCareRepository
    private lateinit var mockNotifier: VisitNotifier

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockInvoiceRepo = mockk()
        mockKinCareRepo = mockk()
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
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(emptyList())
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(TestFixtures.businessSettings)
        // Stage 2 Step 2: Home now loads invoices for the weekly-revenue tile.
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(emptyList())
        // Gatekeeper widget: Home now loads all sessions for the visit-gap ranking.
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        // Care-flags widget (AO-37): Home also loads all kin to join against sessions.
        coEvery { mockRepo.getAllKin() } returns Result.success(emptyList())
    }

    /**
     * ISSUE #582: a fix provider that hands back whatever the test wants,
     * `null` by default. Injected rather than defaulted because the real one
     * reaches for the application context, and because "the phone could not get
     * a fix" is a case worth exercising, not a case worth mocking away.
     */
    private class FakeArrivalFixes(var fix: ArrivalFix? = null) : ArrivalFixProvider {
        var calls = 0
        override suspend fun currentFix(): ArrivalFix? {
            calls++
            return fix
        }
    }

    private fun buildViewModel(arrivalFixes: ArrivalFixProvider = FakeArrivalFixes()) =
        HomeViewModel(
            repo = mockRepo,
            invoiceRepo = mockInvoiceRepo,
            kinCareRepo = mockKinCareRepo,
            notifier = mockNotifier,
            arrivalFixes = arrivalFixes,
        )

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
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(listOf(autoCompleteSession))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockKinCareRepo.markSessionComplete(any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returnsMany listOf(
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
        coEvery { mockKinCareRepo.markSessionComplete(any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returnsMany listOf(
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
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(listOf(TestFixtures.session1))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(1, state.todayVisits.size)
        assertEquals(TestFixtures.kinfolk1, state.todayVisits[0].kinfolk)
    }

    @Test
    fun `complete sets pendingActionSessionId during action`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(listOf(TestFixtures.session1))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockKinCareRepo.markSessionComplete(any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.complete("ses1")
        advanceUntilIdle()

        assertNull(vm.uiState.value.pendingActionSessionId)
    }

    // ── ISSUE #519: arriving auto-starts tracking only if the operator says so ──
    //
    // `autoStartTrackingOnVisitStart` was persisted by the Settings panel and read
    // by nothing: arriving always started tracking under the master switch alone,
    // so the "Auto-Start Tracking on Visit Start" toggle changed nothing. These
    // three cases fail against that code, because the first one starts the
    // service when the operator has turned auto-start off.
    private fun arriveWithSettings(settings: BusinessSettings): android.content.Context {
        val context = mockk<android.content.Context>(relaxed = true)
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returns Result.success(listOf(TestFixtures.session1))
        coEvery { mockRepo.getKinfolkById("kf1") } returns Result.success(TestFixtures.kinfolk1)
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(settings)
        coEvery { mockKinCareRepo.markSessionArrived(any(), any()) } returns Result.success(ARRIVED_AT)
        coEvery { mockRepo.logActivity(any()) } returns Result.success(Unit)
        return context
    }

    // ── #832: the household notification carries the time just stamped ──────

    @Test
    fun `arriving notifies with the arrivedAt it just wrote`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings())
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.arrived("ses1", context)
        advanceUntilIdle()

        coVerify(exactly = 1) {
            mockNotifier.notify(VisitNotifier.Event.ARRIVED, any(), any(), any(), ARRIVED_AT, any())
        }
    }

    @Test
    fun `a re-arrival sends a new time, so the server treats it as a new notification`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings())
        coEvery { mockKinCareRepo.markSessionArrived(any(), any()) } returnsMany
            listOf(Result.success(ARRIVED_AT), Result.success(REARRIVED_AT))
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.arrived("ses1", context)
        advanceUntilIdle()
        vm.arrived("ses1", context)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockNotifier.notify(VisitNotifier.Event.ARRIVED, any(), any(), any(), ARRIVED_AT, any()) }
        coVerify(exactly = 1) { mockNotifier.notify(VisitNotifier.Event.ARRIVED, any(), any(), any(), REARRIVED_AT, any()) }
    }

    @Test
    fun `departing notifies with the departedAt it just wrote`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings())
        coEvery { mockKinCareRepo.markSessionDeparted(any()) } returns Result.success(DEPARTED_AT)
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.departed("ses1", context)
        advanceUntilIdle()

        coVerify(exactly = 1) {
            mockNotifier.notify(VisitNotifier.Event.DEPARTED, any(), any(), any(), DEPARTED_AT, any())
        }
    }

    @Test
    fun `the stamped time converts to the epoch millis the server names the notification by`() {
        assertEquals(java.time.Instant.parse(ARRIVED_AT).toEpochMilli(), VisitNotifier.epochMillisOrNull(ARRIVED_AT))
        assertNull(VisitNotifier.epochMillisOrNull(null))
        assertNull(VisitNotifier.epochMillisOrNull(""))
        assertNull(VisitNotifier.epochMillisOrNull("not a time"))
    }

    private companion object {
        const val ARRIVED_AT = "2026-09-14T15:00:00Z"
        const val REARRIVED_AT = "2026-09-14T15:03:00Z"
        const val DEPARTED_AT = "2026-09-14T16:00:00Z"
    }
    @Test
    fun `arriving does NOT start tracking when auto-start is off`() = runTest(testDispatcher) {
        val context = arriveWithSettings(
            BusinessSettings(enableGPSTrackingForAllVisits = true, autoStartTrackingOnVisitStart = false)
        )
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.arrived("ses1", context)
        advanceUntilIdle()
        verify(exactly = 0) { context.startForegroundService(any()) }
    }
    @Test
    fun `arriving starts tracking when auto-start is on`() = runTest(testDispatcher) {
        val context = arriveWithSettings(
            BusinessSettings(enableGPSTrackingForAllVisits = true, autoStartTrackingOnVisitStart = true)
        )
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.arrived("ses1", context)
        advanceUntilIdle()
        verify(exactly = 1) { context.startForegroundService(any()) }
    }
    @Test
    fun `the master GPS switch still wins over auto-start`() = runTest(testDispatcher) {
        val context = arriveWithSettings(
            BusinessSettings(enableGPSTrackingForAllVisits = false, autoStartTrackingOnVisitStart = true)
        )
        val vm = buildViewModel()
        advanceUntilIdle()
        vm.arrived("ses1", context)
        advanceUntilIdle()
        verify(exactly = 0) { context.startForegroundService(any()) }
    }

    // ── #582: the arrival-location check ────────────────────────────────────

    /**
     * THE ARRIVAL COMES FIRST AND IS NEVER GATED ON THE CHECK. The arrival is a
     * direct Firestore patch riding the offline write queue; the check is a
     * callable. If the order were reversed, or the arrival waited on the check,
     * an Auntie between houses with no signal could not mark a visit at all.
     */
    @Test
    fun `the arrival is recorded before the location check runs, and never waits on it`() =
        runTest(testDispatcher) {
            val context = arriveWithSettings(
                BusinessSettings(requireArrivalDepartureVerification = true)
            )
            val fixes = FakeArrivalFixes(ArrivalFix(34.05, -118.24, 8.0))
            coEvery { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
                Result.success(
                    ArrivalCheckOutcome(ArrivalCheckStatus.WITHIN, 30.0, 150, verificationRequired = true)
                )
            val vm = buildViewModel(fixes)
            advanceUntilIdle()

            vm.arrived("ses1", context)
            advanceUntilIdle()

            coVerify(exactly = 1) { mockKinCareRepo.markSessionArrived("ses1", "") }
            coVerify(exactly = 1) { mockKinCareRepo.verifyVisitArrival("ses1", 34.05, -118.24, 8.0) }
        }

    /** A verified arrival says nothing: the banner is for the cases that need one. */
    @Test
    fun `a verified arrival raises no notice`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings(requireArrivalDepartureVerification = true))
        coEvery { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
            Result.success(
                ArrivalCheckOutcome(ArrivalCheckStatus.WITHIN, 30.0, 150, verificationRequired = true)
            )
        val vm = buildViewModel(FakeArrivalFixes(ArrivalFix(34.05, -118.24, 8.0)))
        advanceUntilIdle()

        vm.arrived("ses1", context)
        advanceUntilIdle()

        assertNull(vm.uiState.value.arrivalCheckNotice)
    }

    /**
     * The message this whole path exists to deliver, and it is delivered NOW —
     * while she is still standing there — rather than hours later at COMPLETE.
     */
    @Test
    fun `an arrival outside the radius warns at once, naming the distance`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings(requireArrivalDepartureVerification = true))
        coEvery { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
            Result.success(
                ArrivalCheckOutcome(ArrivalCheckStatus.OUTSIDE, 2400.0, 150, verificationRequired = true)
            )
        val vm = buildViewModel(FakeArrivalFixes(ArrivalFix(34.09, -118.30, 10.0)))
        advanceUntilIdle()

        vm.arrived("ses1", context)
        advanceUntilIdle()

        val notice = vm.uiState.value.arrivalCheckNotice
        assertNotNull(notice)
        assertTrue(notice!!, notice.contains("2.4 km"))
        // The arrival still landed. This is a warning, not a failed action.
        coVerify(exactly = 1) { mockKinCareRepo.markSessionArrived("ses1", "") }
    }

    /**
     * No permission, no fix indoors, location off: the provider returns null,
     * the callable is never called, and the Auntie is told the visit is still
     * completable — because it is.
     */
    @Test
    fun `no fix means no call, and a notice that says the visit still completes`() =
        runTest(testDispatcher) {
            val context = arriveWithSettings(
                BusinessSettings(requireArrivalDepartureVerification = true)
            )
            val fixes = FakeArrivalFixes(fix = null)
            val vm = buildViewModel(fixes)
            advanceUntilIdle()

            vm.arrived("ses1", context)
            advanceUntilIdle()

            assertEquals(1, fixes.calls)
            coVerify(exactly = 0) { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) }
            val notice = vm.uiState.value.arrivalCheckNotice
            assertNotNull(notice)
            assertTrue(notice!!, notice.contains("can still be completed"))
        }

    /** A failed call is indistinguishable from no fix: neither produced evidence, both complete. */
    @Test
    fun `a failed check is treated as no evidence, not as a failed arrival`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings(requireArrivalDepartureVerification = true))
        coEvery { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
            Result.failure(IllegalStateException("offline"))
        val vm = buildViewModel(FakeArrivalFixes(ArrivalFix(34.05, -118.24, 8.0)))
        advanceUntilIdle()

        vm.arrived("ses1", context)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.arrivalCheckNotice!!.contains("can still be completed"))
        assertNull("a failed check is not an action error", vm.uiState.value.actionError)
    }

    /** With the rule off, the Auntie is told nothing about a rule that does not apply to her. */
    @Test
    fun `nothing is said when the operator has arrival verification switched off`() =
        runTest(testDispatcher) {
            val context = arriveWithSettings(
                BusinessSettings(requireArrivalDepartureVerification = false)
            )
            coEvery { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
                Result.success(
                    ArrivalCheckOutcome(ArrivalCheckStatus.OUTSIDE, 2400.0, 150, verificationRequired = false)
                )
            val vm = buildViewModel(FakeArrivalFixes(ArrivalFix(34.09, -118.30, 10.0)))
            advanceUntilIdle()

            vm.arrived("ses1", context)
            advanceUntilIdle()

            assertNull(vm.uiState.value.arrivalCheckNotice)
        }

    /**
     * REGRESSION, and the reason this test exists rather than being obvious.
     * `load()` REBUILDS `HomeUiState` from scratch instead of copying it — the
     * diff-vs-rebuild trap this codebase is known for, here on UI state — and
     * `runOnSession` calls `load()` in its `finally`, immediately after the
     * arrival that raised the notice. Without the carry-forward in `load()`, the
     * warning was wiped microseconds after it was set and the Auntie never saw
     * it. Caught by these tests failing, not by reading the code.
     */
    @Test
    fun `the refresh that follows an arrival does not wipe the notice`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings(requireArrivalDepartureVerification = true))
        coEvery { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
            Result.success(
                ArrivalCheckOutcome(ArrivalCheckStatus.OUTSIDE, 2400.0, 150, verificationRequired = true)
            )
        val vm = buildViewModel(FakeArrivalFixes(ArrivalFix(34.09, -118.30, 10.0)))
        advanceUntilIdle()

        vm.arrived("ses1", context)
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.arrivalCheckNotice)

        // A further refresh, the way a pull-to-refresh would.
        vm.load()
        advanceUntilIdle()
        assertNotNull(
            "load() rebuilds the state wholesale and must carry the notice",
            vm.uiState.value.arrivalCheckNotice,
        )
    }

    @Test
    fun `the notice can be dismissed`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings(requireArrivalDepartureVerification = true))
        val vm = buildViewModel(FakeArrivalFixes(fix = null))
        advanceUntilIdle()
        vm.arrived("ses1", context)
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.arrivalCheckNotice)

        vm.clearArrivalCheckNotice()
        assertNull(vm.uiState.value.arrivalCheckNotice)
    }

    /** A device that reports no accuracy must send none, not claim a perfect fix. */
    @Test
    fun `a fix with no reported accuracy is sent without one`() = runTest(testDispatcher) {
        val context = arriveWithSettings(BusinessSettings(requireArrivalDepartureVerification = true))
        coEvery { mockKinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
            Result.success(
                ArrivalCheckOutcome(ArrivalCheckStatus.UNVERIFIED, null, 150, verificationRequired = true)
            )
        val vm = buildViewModel(FakeArrivalFixes(ArrivalFix(34.05, -118.24, null)))
        advanceUntilIdle()

        vm.arrived("ses1", context)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockKinCareRepo.verifyVisitArrival("ses1", 34.05, -118.24, null) }
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
        coEvery { mockKinCareRepo.getKinCareSessionsForDay(any(), any()) } returns Result.failure(RuntimeException("Auth expired"))

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
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(
            listOf(
                com.tribetails.auntieos.data.model.Invoice(id = "i1", status = "unpaid", total = 120.0, amountDue = 120.0, date = "2026-06-01"),
                com.tribetails.auntieos.data.model.Invoice(id = "i2", status = "unpaid", total = 30.5, amountDue = 30.5, date = "2026-06-02"),
                com.tribetails.auntieos.data.model.Invoice(id = "i3", status = "paid", total = 99.0, amountDue = 0.0, date = "2026-06-02"),
            ),
        )
        val lastVisit = java.time.LocalDate.now().minusDays(15).toString()
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(
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
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.failure(RuntimeException("boom"))

        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.gapsLoaded)
        assertTrue(state.visitGaps.isEmpty())
        assertEquals("Other tiles still render", 2, state.kinfolkCount)
    }

    // ───────────────────────────────────────────────────────────────────────
    // 17.3 Dashboard save: the failure path and the ordering.
    //
    // A save used to be fire and forget, so a write that failed left the operator
    // looking at an arrangement that existed nowhere and finding out at the next
    // cold start. And nothing serialized the writes, so a fast run of taps could
    // settle in either order.
    //
    // Nothing here needs a profile: the callable takes the uid from req.auth and
    // merge-writes its own field, which is why these tests can exist at all.
    // ───────────────────────────────────────────────────────────────────────

    // Three layouts of the same three cards, so each save is distinguishable.
    private val layoutA = listOf("stats:wide", "todaysPack:compact", "kintales:compact")
    private val layoutB = listOf("todaysPack:compact", "stats:wide", "kintales:compact")
    private val layoutC = listOf("todaysPack:compact", "kintales:compact", "stats:wide")

    @Test
    fun `a failure mid-run reverts to the server-confirmed layout and drops the rest of the run`() = runTest(testDispatcher) {
        // A lands, B fails, C was queued behind B. Both writes are slow so all three
        // taps happen before any of them comes back, which is the situation the
        // operator actually creates by tapping an arrow three times.
        coEvery { mockRepo.saveDashboardLayout(layoutA) } coAnswers { delay(10); Result.success(layoutA) }
        coEvery { mockRepo.saveDashboardLayout(layoutB) } coAnswers { delay(10); Result.failure(RuntimeException("offline")) }
        coEvery { mockRepo.saveDashboardLayout(layoutC) } returns Result.success(layoutC)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.saveDashboard(layoutA, "Stats moved down to position 1 of 3.")
        vm.saveDashboard(layoutB, "Stats moved down to position 2 of 3.")
        vm.saveDashboard(layoutC, "Stats moved down to position 3 of 3.")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(
            "Must revert to the layout the SERVER confirmed (A), not to the step before the failure (B is unsaved too)",
            layoutA,
            state.dashboardWidgets,
        )
        assertNotNull("A failed save must be visible", state.dashboardError)
        assertTrue(
            "The banner must say the board was put back, not just that something broke: ${state.dashboardError}",
            state.dashboardError!!.contains("back the way it was"),
        )
        assertTrue("The banner names the cause", state.dashboardError!!.contains("offline"))
        assertEquals("A change that did not stick must not be announced as done", "", state.dashboardAnnouncement)
        coVerify(exactly = 0) {
            // C would persist an arrangement nobody is looking at: the board is at A.
            mockRepo.saveDashboardLayout(layoutC)
        }
    }

    @Test
    fun `a failure with nothing yet confirmed reverts to the shipped default`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveDashboardLayout(layoutB) } returns Result.failure(RuntimeException("permission denied"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.saveDashboard(layoutB, "Stats moved down to position 2 of 3.")
        advanceUntilIdle()

        // Empty tokens resolve to DEFAULT_DASHBOARD, which is what was on screen
        // before the tap, and is what is genuinely stored.
        assertEquals(emptyList<String>(), vm.uiState.value.dashboardWidgets)
        assertNotNull(vm.uiState.value.dashboardError)
    }

    @Test
    fun `rapid saves land in the order the operator made them`() = runTest(testDispatcher) {
        val landed = mutableListOf<List<String>>()
        var started = 0
        coEvery { mockRepo.saveDashboardLayout(any()) } coAnswers {
            val tokens = firstArg<List<String>>()
            started += 1
            // The FIRST write is the slow one. Unserialized, the second would start
            // alongside it and finish first, leaving the stored list at B while the
            // screen shows C. That inversion is the whole defect.
            delay(if (started == 1) 100L else 1L)
            landed += tokens
            Result.success(tokens)
        }

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.saveDashboard(layoutB)
        vm.saveDashboard(layoutC)
        advanceUntilIdle()

        assertEquals("Writes must settle in tap order", listOf(layoutB, layoutC), landed)
        assertEquals("The board ends on the last tap", layoutC, vm.uiState.value.dashboardWidgets)
        assertNull(vm.uiState.value.dashboardError)
    }

    @Test
    fun `save writes the layout field only and never reads the profile first`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveDashboardLayout(layoutB) } returns Result.success(layoutB)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.saveDashboard(layoutB)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.saveDashboardLayout(layoutB) }
        // A read-then-whole-document-write is what could clobber a theme or nav pref
        // saved from another screen in the gap. Neither call may happen.
        coVerify(exactly = 0) { mockRepo.saveUserProfile(any(), any()) }
        verify(exactly = 0) { mockRepo.observeUserProfile(any()) }
    }

    @Test
    fun `the board follows what the server stored, not the optimistic copy`() = runTest(testDispatcher) {
        // The server is the authority on what landed. Here it keeps a shorter list
        // than was sent, and the board has to follow it.
        val kept = listOf("stats:wide", "kintales:compact")
        coEvery { mockRepo.saveDashboardLayout(layoutB) } returns Result.success(kept)

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.saveDashboard(layoutB)
        advanceUntilIdle()

        assertEquals(kept, vm.uiState.value.dashboardWidgets)
    }

    @Test
    fun `a change that saved is announced, and the banner can be dismissed`() = runTest(testDispatcher) {
        coEvery { mockRepo.saveDashboardLayout(layoutB) } returns Result.success(layoutB)
        coEvery { mockRepo.saveDashboardLayout(layoutC) } returns Result.failure(RuntimeException("nope"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.saveDashboard(layoutB, "Stats moved down to position 2 of 3.")
        advanceUntilIdle()
        assertEquals("Stats moved down to position 2 of 3.", vm.uiState.value.dashboardAnnouncement)

        vm.saveDashboard(layoutC, "Stats moved down to position 3 of 3.")
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.dashboardError)

        vm.clearDashboardError()
        assertNull(vm.uiState.value.dashboardError)
        assertEquals("Dismissing the banner does not move the board", layoutB, vm.uiState.value.dashboardWidgets)
    }
}
