package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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

    private fun vm() = AdminDataViewModel(
        repository = repo,
        invoiceRepository = mockk(relaxed = true),
        kinCareRepository = kinCareRepo,
        visitNotifier = { notifier },
    )

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
        coEvery { notifier.notify(any(), any(), any(), any(), any(), any()) } returns
            Result.success(VisitNotifier.DispatchResult(listOf("n1"), suppressed = false))
        val seen = vm().omw()
        advanceUntilIdle()

        coVerify(exactly = 1) { kinCareRepo.patchKinCareSession("dre1", omwPatch) }
        coVerify(exactly = 1) { notifier.notify(VisitNotifier.Event.ON_MY_WAY, session, any(), any(), AT, any()) }
        assertNull(seen.written)
        assertEquals("Dre East was notified.", seen.sentence)
    }

    @Test
    fun `the Nov 10 case reads no portal account, and the tap still landed`() = runTest(testDispatcher) {
        coEvery { notifier.notify(any(), any(), any(), any(), any(), any()) } returns Result.success(
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
        coVerify(exactly = 0) { notifier.notify(any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a row with no booking link is named without a call`() = runTest(testDispatcher) {
        val seen = vm().omw(session.copy(kinCareBatchId = null, kinCareVisitId = null))
        advanceUntilIdle()

        coVerify(exactly = 0) { notifier.notify(any(), any(), any(), any(), any(), any()) }
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

    private companion object {
        const val AT = "2026-11-10T15:00:00Z"
    }
}
