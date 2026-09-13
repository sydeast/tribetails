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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
/**
 * #814: the broadcast key, AuntieOS Android.
 *
 * `broadcastMessage` sends real email and SMS to every household an audience
 * matched, and the SDK reports a dropped request and a lost reply as the same
 * `INTERNAL`. So the operator who sees a failure and presses Send again is the
 * one who used to send the whole audience a second copy. The key held across
 * that press is what makes the server answer from the broadcast the first press
 * claimed.
 *
 * Mirrors `auntieos-admin/src/screens/CommunicateCompose.test.tsx`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CommunicateBroadcastIdempotencyTest {
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
    private fun capturedKeys(times: Int): List<String?> {
        val keys = mutableListOf<String?>()
        coVerify(exactly = times) {
            repo.broadcastMessage(any(), any(), any(), any(), any(), captureNullable(keys))
        }
        return keys
    }
    @Test
    fun `one key is minted and held across the operator's own retry`() = runTest(testDispatcher) {
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.failure(RuntimeException("internal")) andThen
            Result.success(BroadcastResult("b1", 3, emptyMap(), deduped = true))
        val vm = ready()
        vm.sendBroadcast()
        advanceUntilIdle()
        vm.sendBroadcast()
        advanceUntilIdle()
        val keys = capturedKeys(2)
        assertTrue(keys[0]!!.matches(Regex("^bcast_\\d+_[a-z0-9]+$")))
        assertEquals(keys[0], keys[1])
        // The summary reports the dedupe rather than claiming a second send.
        assertTrue(broadcastSummary(vm.uiState.value.broadcastResult!!).contains("Nothing went out twice"))
    }
    @Test
    fun `an edited message mints a new key, because it is a different send`() = runTest(testDispatcher) {
        coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
            Result.failure(RuntimeException("internal")) andThen
            Result.success(BroadcastResult("b2", 3, emptyMap()))
        val vm = ready()
        vm.sendBroadcast()
        advanceUntilIdle()
        vm.setBcBody("The Den has different news.")
        vm.sendBroadcast()
        advanceUntilIdle()
        val keys = capturedKeys(2)
        assertNotEquals(keys[0], keys[1])
    }
    @Test
    fun `a successful send releases the key, so the next message is its own send`() =
        runTest(testDispatcher) {
            coEvery { repo.broadcastMessage(any(), any(), any(), any(), any(), any()) } returns
                Result.success(BroadcastResult("b1", 3, emptyMap()))
            val vm = ready()
            vm.sendBroadcast()
            advanceUntilIdle()
            vm.sendBroadcast()
            advanceUntilIdle()
            // Same words, but the first send completed: holding the key would make
            // the second send a replay of a broadcast the operator meant to repeat.
            val keys = capturedKeys(2)
            assertNotEquals(keys[0], keys[1])
        }
}
