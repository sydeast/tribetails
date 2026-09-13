package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.RecentComms
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #823: a broadcast whose fan-out outlives its own callable, AuntieOS Android.
 *
 * `broadcastMessage` sends for fifteen seconds and a cron sweep carries the
 * rest, because five thousand households at five to six Firestore round trips
 * each cannot be reached inside a function's 540-second ceiling. So a send to a
 * large segment keeps going for minutes after the reply, and before this the
 * screen said "Broadcast sent" over one leg of it.
 *
 * Mirrors `auntieos-admin/src/screens/CommunicateCompose.test.tsx`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateBroadcastProgressTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getKinfolk() } returns Result.success(TestFixtures.allKinfolk)
        coEvery { repo.recentCommsForKinfolk(any()) } returns Result.success(RecentComms())
        coEvery { repo.getHouseholdBank(any()) } returns Result.success(null)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun ready(): CommunicateViewModel {
        val vm = CommunicateViewModel(repo = repo)
        vm.setBcChannels(setOf(BroadcastChannel.Email))
        vm.setBcSubject("Spring news")
        vm.setBcBody("The Den has news.")
        return vm
    }

    private fun running(sent: Int = 61, stopRequested: Boolean = false) = BroadcastProgress(
        broadcastId = "b1",
        fanoutState = BroadcastFanoutState.Running,
        sent = sent,
        audienceSize = 900,
        reached = sent,
        suppressedByPrefs = 0,
        stopRequested = stopRequested,
    )

    @Test
    fun `a handed-off send reads its own progress without being asked`() = runTest(testDispatcher) {
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(BroadcastResult(broadcastId = "b1", recipientCount = 900, perChannel = emptyMap(), pending = true, sent = 61, audienceSize = 900))
        coEvery { repo.getBroadcastProgress("b1") } returns Result.success(running())

        val vm = ready()
        vm.sendBroadcast()
        advanceUntilIdle()

        // Taken straight away rather than waiting for the operator to wonder.
        coVerify(exactly = 1) { repo.getBroadcastProgress("b1") }
        assertEquals(61, vm.uiState.value.broadcastProgress?.sent)
        assertEquals(true, vm.uiState.value.broadcastResult?.pending)
    }

    @Test
    fun `a send that finished inside the call reads no progress at all`() = runTest(testDispatcher) {
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(BroadcastResult(broadcastId = "b1", recipientCount = 3, perChannel = emptyMap(), pending = false))

        val vm = ready()
        vm.sendBroadcast()
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.getBroadcastProgress(any()) }
        assertNull(vm.uiState.value.broadcastProgress)
    }

    /**
     * No poll. The fan-out is on the server, the sweep runs once a minute, and
     * the count moves about once every twenty-five seconds, so the manual sync
     * the 2026-09-12 ruling asks for is what this offers instead. The press is
     * counted because a tap with no visible consequence reads as a dead button.
     */
    @Test
    fun `the manual re-read asks again and counts the press`() = runTest(testDispatcher) {
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(BroadcastResult(broadcastId = "b1", recipientCount = 900, perChannel = emptyMap(), pending = true))
        coEvery { repo.getBroadcastProgress("b1") } returns Result.success(running())

        val vm = ready()
        vm.sendBroadcast()
        advanceUntilIdle()
        assertEquals(0, vm.uiState.value.broadcastChecks)

        vm.checkBroadcastProgress()
        advanceUntilIdle()

        assertEquals(1, vm.uiState.value.broadcastChecks)
        coVerify(exactly = 2) { repo.getBroadcastProgress("b1") }
    }

    @Test
    fun `a progress read that fails claims no progress rather than zero`() = runTest(testDispatcher) {
        // "We could not look" and "nothing has gone out" are different facts,
        // and a progress bar cannot tell them apart.
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(BroadcastResult(broadcastId = "b1", recipientCount = 900, perChannel = emptyMap(), pending = true))
        coEvery { repo.getBroadcastProgress("b1") } returns Result.failure(RuntimeException("unavailable"))

        val vm = ready()
        vm.sendBroadcast()
        advanceUntilIdle()

        assertNull(vm.uiState.value.broadcastProgress)
        assertTrue(vm.uiState.value.broadcastError.orEmpty().contains("getBroadcastProgress failed"))
    }

    /**
     * Stopping stops the REMAINDER. Email and SMS already sent cannot be
     * recalled, and the notice says so in numbers rather than announcing a
     * cancellation that did not happen.
     */
    @Test
    fun `stopping is honest about what already went out`() = runTest(testDispatcher) {
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.success(BroadcastResult(broadcastId = "b1", recipientCount = 900, perChannel = emptyMap(), pending = true))
        coEvery { repo.getBroadcastProgress("b1") } returns Result.success(running())
        coEvery { repo.stopBroadcast("b1") } returns Result.success(StopBroadcastResult(sent = 61, neverSent = 839))

        val vm = ready()
        vm.sendBroadcast()
        advanceUntilIdle()

        vm.stopBroadcast()
        advanceUntilIdle()

        val notice = vm.uiState.value.stopBroadcastNotice.orEmpty()
        assertTrue(notice.contains("61 households have already been contacted and cannot be called back"))
        assertTrue(notice.contains("839 will not be"))
        // The stop is followed by a re-read, so the screen stops offering a
        // button for something already asked for.
        coVerify(exactly = 2) { repo.getBroadcastProgress("b1") }
    }

    @Test
    fun `the sending line names a stalled fan-out rather than calling it slow`() {
        val stalled = running().copy(fanoutState = BroadcastFanoutState.Stalled)
        assertTrue(broadcastSendingLabel(stalled).startsWith("Stopped at 61 of 900 households"))
        assertEquals("61 of 900 households so far.", broadcastSendingLabel(running()))
        val done = running().copy(fanoutState = BroadcastFanoutState.Complete, sent = 900)
        assertEquals("Finished. 900 of 900 households.", broadcastSendingLabel(done))
    }

    @Test
    fun `a progress reply with no fan-out state is not drawn as in flight`() {
        // A send from a backend that does not report progress is not in flight,
        // and a progress bar that could never move would be worse than none.
        val decoded = decodeBroadcastProgress("b1", mapOf("sent" to 3))
        assertEquals(BroadcastFanoutState.Complete, decoded.fanoutState)
        assertEquals(false, decoded.running)
    }
}
