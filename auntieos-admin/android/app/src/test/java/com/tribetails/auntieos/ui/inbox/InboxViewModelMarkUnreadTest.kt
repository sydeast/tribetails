package com.tribetails.auntieos.ui.inbox

import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
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
 * #1611: Mark unread on an open thread. The flag comes back from the server's
 * re-read list, never a local flip, and the thread closes so the next read
 * does not clear it again.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InboxViewModelMarkUnreadTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    private val read = listOf(ConversationSummary("a", "A", "hi", 2, "kinfolk", false, 1))
    private val unread = read.map { it.copy(unreadForAdmin = true) }

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        every { mockRepo.observeVoicemails() } returns flowOf(emptyList())
        every { mockRepo.observeCalls() } returns flowOf(emptyList())
        every { mockRepo.observeSmsMessages() } returns flowOf(emptyList())
        every { mockRepo.observeEmails() } returns flowOf(emptyList())
        coEvery { mockRepo.listConversations() } returns Result.success(read)
        coEvery { mockRepo.getConversationThread("a") } returns Result.success(emptyList())
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun `marks the open thread unread, closes it, and re-reads the list`() = runTest(testDispatcher) {
        coEvery { mockRepo.markConversationUnread("a") } returns Result.success(Unit)
        val vm = InboxViewModel(repository = mockRepo)
        advanceUntilIdle()
        vm.openConversation("a")
        advanceUntilIdle()
        assertEquals("a", vm.selectedConversationId.value)
        coEvery { mockRepo.listConversations() } returns Result.success(unread)

        vm.markConversationUnread()
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.markConversationUnread("a") }
        assertNull(vm.selectedConversationId.value)
        assertNull(vm.conversationError.value)
        assertFalse(vm.markingUnread.value)
        assertEquals(1, unreadConversationCount(vm.conversations.value))
    }

    @Test
    fun `a refused write says why, keeps the thread open and the row read`() = runTest(testDispatcher) {
        coEvery { mockRepo.markConversationUnread("a") } returns Result.failure(RuntimeException("permission-denied"))
        val vm = InboxViewModel(repository = mockRepo)
        advanceUntilIdle()
        vm.openConversation("a")
        advanceUntilIdle()

        vm.markConversationUnread()
        advanceUntilIdle()

        assertTrue(vm.conversationError.value!!.contains("permission-denied"))
        assertEquals("a", vm.selectedConversationId.value)
        assertEquals(0, unreadConversationCount(vm.conversations.value))
    }

    @Test
    fun `does nothing with no thread open`() = runTest(testDispatcher) {
        val vm = InboxViewModel(repository = mockRepo)
        advanceUntilIdle()
        vm.markConversationUnread()
        advanceUntilIdle()
        coVerify(exactly = 0) { mockRepo.markConversationUnread(any()) }
    }
}
