package com.tribetails.auntieos.ui.inbox

import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Android parity for PR7 item 6's bulk clear (`markAllThreadsRead`).
 *
 * The rule the failure test pins is the same one the web admin's test pins:
 * there is NO optimistic clear. The unread dot on each row and the Inbox badge
 * both read `unreadForAdmin` off the loaded list, so a local clear the server
 * then refused would leave the screen claiming an empty inbox.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InboxViewModelMarkAllReadTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    private val unread = listOf(
        ConversationSummary("a", "A", "hi", 2, "kinfolk", true, 1),
        ConversationSummary("b", "B", "hey", 1, "kinfolk", true, 1),
    )
    private val allRead = unread.map { it.copy(unreadForAdmin = false) }

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        every { mockRepo.observeVoicemails() } returns flowOf(emptyList())
        every { mockRepo.observeCalls() } returns flowOf(emptyList())
        every { mockRepo.observeSmsMessages() } returns flowOf(emptyList())
        every { mockRepo.observeEmails() } returns flowOf(emptyList())
        coEvery { mockRepo.listConversations() } returns Result.success(unread)
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun `marks every waiting thread read, reports the count, and re-reads the list`() =
        runTest(testDispatcher) {
            coEvery { mockRepo.markAllThreadsRead() } returns Result.success(2)
            val vm = InboxViewModel(repository = mockRepo)
            advanceUntilIdle()
            // The reload after the clear returns the cleared list.
            coEvery { mockRepo.listConversations() } returns Result.success(allRead)

            vm.markAllThreadsRead()
            advanceUntilIdle()

            coVerify(exactly = 1) { mockRepo.markAllThreadsRead() }
            assertEquals("2 threads marked read", vm.bulkReadResult.value)
            assertNull(vm.conversationError.value)
            // The cleared state came from the SERVER's list, not a local edit.
            assertEquals(0, unreadConversationCount(vm.conversations.value))
            coVerify(atLeast = 2) { mockRepo.listConversations() }
        }

    @Test
    fun `says 1 thread singular for a single cleared thread`() = runTest(testDispatcher) {
        coEvery { mockRepo.markAllThreadsRead() } returns Result.success(1)
        val vm = InboxViewModel(repository = mockRepo)
        advanceUntilIdle()

        vm.markAllThreadsRead()
        advanceUntilIdle()

        assertEquals("1 thread marked read", vm.bulkReadResult.value)
    }

    @Test
    fun `a failed write surfaces the error and leaves every unread row unread`() =
        runTest(testDispatcher) {
            coEvery { mockRepo.markAllThreadsRead() } returns
                Result.failure(RuntimeException("unavailable"))
            val vm = InboxViewModel(repository = mockRepo)
            advanceUntilIdle()

            vm.markAllThreadsRead()
            advanceUntilIdle()

            assertTrue(vm.conversationError.value!!.contains("unavailable"))
            assertNull(vm.bulkReadResult.value)
            // Untouched: 2 threads still waiting, exactly as the server says.
            assertEquals(2, unreadConversationCount(vm.conversations.value))
        }

    @Test
    fun `does not fire a second write while the first is still in flight`() =
        runTest(testDispatcher) {
            val gate = CompletableDeferred<Result<Int>>()
            coEvery { mockRepo.markAllThreadsRead() } coAnswers { gate.await() }
            val vm = InboxViewModel(repository = mockRepo)
            advanceUntilIdle()

            vm.markAllThreadsRead()
            vm.markAllThreadsRead()
            assertTrue(vm.bulkReadInFlight.value)
            gate.complete(Result.success(2))
            advanceUntilIdle()

            coVerify(exactly = 1) { mockRepo.markAllThreadsRead() }
            assertFalse(vm.bulkReadInFlight.value)
        }
}
