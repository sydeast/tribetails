package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.domain.VisitNoticeReach
import com.tribetails.auntieos.domain.VisitNotifyOutcome
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * #1794: Auntie Time's On The Way and Arrived on Android.
 *
 * Before this the screen patched the status and toasted "On the way - kinfolk
 * notified." without calling [VisitNotifier] at all. These cases pin the new
 * order (write, then dispatch, then the sentence) and the switch the confirm
 * reads.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AuntieTimeClockNoticeTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository
    private lateinit var notifier: VisitNotifier

    private val session = KinCareSession(
        id = "dre1",
        kinfolkId = "kfDre",
        kinfolkName = "Dre East",
        kinCareBatchId = "b1",
        kinCareVisitId = "v1",
        status = "SCHEDULED",
    )
    private val omwPatch = mapOf<String, Any>("status" to "ON_MY_WAY", "onMyWayAt" to AT)

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk(relaxed = true)
        kinCareRepo = mockk(relaxed = true)
        notifier = mockk()
        coEvery { kinCareRepo.patchKinCareSession(any(), any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings(householdNotificationsLive = false))
        coEvery { repo.getArrivalRuleRequired() } returns Result.success(false)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** #2279: the position the arrival is measured with. Null is "no fix". */
    private var fix: com.tribetails.auntieos.location.ArrivalFix? = null

    private fun vm() = AdminDataViewModel(
        repository = repo,
        invoiceRepository = mockk(relaxed = true),
        kinCareRepository = kinCareRepo,
        visitNotifier = { notifier },
        arrivalFixes = {
            object : com.tribetails.auntieos.location.ArrivalFixProvider {
                override suspend fun currentFix() = fix
            }
        },
    )

    /** #2279: an Arrived tap, and what the screen is told about the range. */
    private fun AdminDataViewModel.arrive(): MutableList<String> {
        val said = mutableListOf<String>()
        clockAndNotify(
            session = session,
            patch = mapOf("status" to "ARRIVED", "arrivedAt" to AT),
            event = VisitNotifier.Event.ARRIVED,
            eventAtIso = AT,
            household = "Dre East",
            onWritten = {},
            onNotified = { _, _ -> },
            onArrivalChecked = { said += it },
        )
        return said
    }

    private fun arrivalChecked(status: com.tribetails.auntieos.domain.ArrivalCheckStatus, required: Boolean = true) {
        coEvery { notifier.awaitStepNotice(any(), any(), any(), any()) } returns
            Result.success(VisitNotifier.DispatchResult(listOf("n1"), suppressed = false))
        coEvery { kinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns Result.success(
            com.tribetails.auntieos.domain.ArrivalCheckOutcome(status, 2400.0, 150, verificationRequired = required),
        )
    }

    // ── #2279: the owner may start outside the range, and it is recorded ──────

    @Test
    fun `an arrival outside the range is measured after it lands, and the owner is told it was recorded`() =
        runTest(testDispatcher) {
            fix = com.tribetails.auntieos.location.ArrivalFix(34.09, -118.30, 10.0)
            arrivalChecked(com.tribetails.auntieos.domain.ArrivalCheckStatus.OUTSIDE)
            val said = vm().arrive()
            advanceUntilIdle()

            // The arrival is the direct write it always was; nothing is asked first.
            coVerify(exactly = 1) { kinCareRepo.patchKinCareSession("dre1", any()) }
            coVerify(exactly = 1) { kinCareRepo.verifyVisitArrival("dre1", 34.09, -118.30, 10.0) }
            assertEquals(
                listOf(
                    "You arrived 2.4 km from this household, outside your 150 m range. " +
                        "That is recorded on the visit and in the Activity Log.",
                ),
                said,
            )
        }

    @Test
    fun `an arrival inside the range says nothing about the range`() = runTest(testDispatcher) {
        fix = com.tribetails.auntieos.location.ArrivalFix(34.05, -118.24, 8.0)
        arrivalChecked(com.tribetails.auntieos.domain.ArrivalCheckStatus.WITHIN)
        val said = vm().arrive()
        advanceUntilIdle()
        coVerify(exactly = 1) { kinCareRepo.verifyVisitArrival("dre1", any(), any(), any()) }
        assertEquals(emptyList<String>(), said)
    }

    @Test
    fun `with the rule off an outside arrival says nothing`() = runTest(testDispatcher) {
        fix = com.tribetails.auntieos.location.ArrivalFix(34.09, -118.30, 10.0)
        arrivalChecked(com.tribetails.auntieos.domain.ArrivalCheckStatus.OUTSIDE, required = false)
        val said = vm().arrive()
        advanceUntilIdle()
        assertEquals(emptyList<String>(), said)
    }

    @Test
    fun `no fix means nothing is measured, and the arrival still lands`() = runTest(testDispatcher) {
        fix = null
        arrivalChecked(com.tribetails.auntieos.domain.ArrivalCheckStatus.OUTSIDE)
        val said = vm().arrive()
        advanceUntilIdle()
        coVerify(exactly = 1) { kinCareRepo.patchKinCareSession("dre1", any()) }
        coVerify(exactly = 0) { kinCareRepo.verifyVisitArrival(any(), any(), any(), any()) }
        assertEquals(emptyList<String>(), said)
    }

    @Test
    fun `a measurement that fails leaves the arrival standing and says nothing`() = runTest(testDispatcher) {
        fix = com.tribetails.auntieos.location.ArrivalFix(34.09, -118.30, 10.0)
        coEvery { notifier.awaitStepNotice(any(), any(), any(), any()) } returns
            Result.success(VisitNotifier.DispatchResult(listOf("n1"), suppressed = false))
        coEvery { kinCareRepo.verifyVisitArrival(any(), any(), any(), any()) } returns
            Result.failure(RuntimeException("offline"))
        val said = vm().arrive()
        advanceUntilIdle()
        coVerify(exactly = 1) { kinCareRepo.patchKinCareSession("dre1", any()) }
        assertEquals(emptyList<String>(), said)
    }

    @Test
    fun `On The Way measures nothing`() = runTest(testDispatcher) {
        fix = com.tribetails.auntieos.location.ArrivalFix(34.09, -118.30, 10.0)
        coEvery { notifier.awaitStepNotice(any(), any(), any(), any()) } returns
            Result.success(VisitNotifier.DispatchResult(listOf("n1"), suppressed = false))
        vm().omw()
        advanceUntilIdle()
        coVerify(exactly = 0) { kinCareRepo.verifyVisitArrival(any(), any(), any(), any()) }
    }

    private class Seen {
        var written: Throwable? = Throwable("not called")
        var outcome: VisitNotifyOutcome? = null
        var sentence: String? = null
    }

    private fun AdminDataViewModel.omw(s: KinCareSession = session): Seen {
        val seen = Seen()
        clockAndNotify(
            session = s,
            patch = omwPatch,
            event = VisitNotifier.Event.ON_MY_WAY,
            eventAtIso = AT,
            household = "Dre East",
            onWritten = { seen.written = it },
            onNotified = { o, text ->
                seen.outcome = o
                seen.sentence = text
            },
        )
        return seen
    }

    @Test
    fun `On The Way patches, then tells the household with the stamped time`() = runTest(testDispatcher) {
        coEvery { notifier.awaitStepNotice(any(), any(), any(), any()) } returns
            Result.success(VisitNotifier.DispatchResult(listOf("n1"), suppressed = false))
        val seen = vm().omw()
        advanceUntilIdle()

        coVerify(exactly = 1) { kinCareRepo.patchKinCareSession("dre1", omwPatch) }
        coVerify(exactly = 1) { notifier.awaitStepNotice(session.id, VisitNotifier.Event.ON_MY_WAY, AT, any()) }
        assertNull(seen.written)
        assertEquals("Dre East was notified.", seen.sentence)
    }

    @Test
    fun `the Nov 10 case reads no portal account, and the tap still landed`() = runTest(testDispatcher) {
        coEvery { notifier.awaitStepNotice(any(), any(), any(), any()) } returns Result.success(
            VisitNotifier.DispatchResult(emptyList(), suppressed = true, reason = "household_has_no_portal_account"),
        )
        val seen = vm().omw()
        advanceUntilIdle()

        assertNull(seen.written)
        assertEquals(VisitNotifyOutcome(false, "household_has_no_portal_account"), seen.outcome)
        assertEquals("Dre East was not notified, because they have no portal account.", seen.sentence)
    }

    @Test
    fun `a failed patch tells nobody and reports the failure`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.patchKinCareSession(any(), any()) } returns Result.failure(RuntimeException("denied"))
        val seen = vm().omw()
        advanceUntilIdle()

        assertEquals("denied", seen.written?.message)
        assertNull(seen.sentence)
        coVerify(exactly = 0) { notifier.awaitStepNotice(any(), any(), any(), any()) }
    }

    @Test
    fun `a row with no booking link is named without a call`() = runTest(testDispatcher) {
        val seen = vm().omw(session.copy(kinCareBatchId = null, kinCareVisitId = null))
        advanceUntilIdle()

        coVerify(exactly = 0) { notifier.awaitStepNotice(any(), any(), any(), any()) }
        assertEquals("Dre East was not notified, because this visit is not linked to a booking.", seen.sentence)
    }

    @Test
    fun `the switch the confirm reads comes off the settings read the board already makes`() = runTest(testDispatcher) {
        val vm = vm()
        assertNull(vm.householdNoticesLive.value)
        vm.loadKinCareSessions()
        advanceUntilIdle()
        assertEquals(false, vm.householdNoticesLive.value)
    }

    // ── #1840: the confirm asks the server, never the roster ────────────────

    private fun AdminDataViewModel.asked(s: KinCareSession = session): MutableList<VisitNoticeReach> {
        val answers = mutableListOf<VisitNoticeReach>()
        previewVisitNotice(s) { answers += it }
        return answers
    }

    @Test
    fun `the confirm is told a claimed household will be notified`() = runTest(testDispatcher) {
        coEvery { notifier.preview("kfDre") } returns Result.success(VisitNotifier.PreviewResult(true))
        val answers = vm().asked()
        advanceUntilIdle()

        assertEquals(listOf<VisitNoticeReach>(VisitNoticeReach.Ready(true, null)), answers)
    }

    @Test
    fun `the confirm is told an unclaimed household has no portal sign-in`() = runTest(testDispatcher) {
        coEvery { notifier.preview("kfDre") } returns
            Result.success(VisitNotifier.PreviewResult(false, "household_has_no_portal_account"))
        val answers = vm().asked()
        advanceUntilIdle()

        assertEquals(
            listOf<VisitNoticeReach>(VisitNoticeReach.Ready(false, "household_has_no_portal_account")),
            answers,
        )
    }

    @Test
    fun `the confirm is told household notices are switched off`() = runTest(testDispatcher) {
        coEvery { notifier.preview("kfDre") } returns
            Result.success(VisitNotifier.PreviewResult(false, "household_notices_off"))
        val answers = vm().asked()
        advanceUntilIdle()

        assertEquals(listOf<VisitNoticeReach>(VisitNoticeReach.Ready(false, "household_notices_off")), answers)
    }

    @Test
    fun `a preview that cannot be made is unknown, never a guess`() = runTest(testDispatcher) {
        coEvery { notifier.preview(any()) } returns Result.failure(RuntimeException("NOT_FOUND"))
        val answers = vm().asked()
        advanceUntilIdle()

        assertEquals(listOf<VisitNoticeReach>(VisitNoticeReach.Unknown), answers)
    }

    @Test
    fun `a preview that throws is unknown too`() = runTest(testDispatcher) {
        coEvery { notifier.preview(any()) } throws IllegalStateException("offline")
        val answers = vm().asked()
        advanceUntilIdle()

        assertEquals(listOf<VisitNoticeReach>(VisitNoticeReach.Unknown), answers)
    }

    @Test
    fun `a visit that cannot be routed to a household is not asked about`() = runTest(testDispatcher) {
        val answers = vm().asked(session.copy(kinCareBatchId = null, kinCareVisitId = null))
        advanceUntilIdle()

        coVerify(exactly = 0) { notifier.preview(any()) }
        assertEquals(emptyList<VisitNoticeReach>(), answers)
    }

    private companion object {
        const val AT = "2026-11-10T15:00:00Z"
    }
}
