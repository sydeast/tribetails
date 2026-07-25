package com.tribetails.auntieos.ui.inbox

import com.tribetails.auntieos.data.model.CallLog
import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.model.VoicemailLog
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.ExternalSendResult
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class InboxViewModelReplyTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        // Stub all calls made in InboxViewModel.init so strict mockk doesn't blow up.
        every { mockRepo.observeVoicemails() } returns flowOf(emptyList())
        every { mockRepo.observeCalls() } returns flowOf(emptyList())
        every { mockRepo.observeSmsMessages() } returns flowOf(emptyList())
        every { mockRepo.observeEmails() } returns flowOf(emptyList())
        coEvery { mockRepo.listConversations() } returns Result.success(emptyList())
    }

    @After fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun `sendSmsReply routes through transactional sendExternalMessage not n8n sendMessage`() = runTest(testDispatcher) {
        coEvery {
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any(), any())
        } returns Result.success(ExternalSendResult("sms", "SMxyz", "+1******2671"))

        val vm = InboxViewModel(repository = mockRepo)
        vm.sendSmsReply(recipientPhone = "+14155552671", body = "hi", kinfolkId = null, voicemailId = null)
        advanceUntilIdle()

        coVerify(exactly = 1) {
            mockRepo.sendExternalMessage(
                channel = "sms",
                to = "+14155552671",
                subject = null,
                body = "hi",
                transactional = true,
                // The Inbox composer is the ONE surface that asks for the mirror.
                // Communicate's one-off panel must never pass it, or the channel
                // list fills with contacts the operator has no thread with.
                mirrorToChannel = true,
            )
        }
        coVerify(exactly = 0) { mockRepo.sendMessage(any()) }
    }

    /**
     * What the operator is told after a reply goes out. Every branch follows a
     * SUCCESSFUL send, so none may read as a failure: an operator who believes a
     * reply failed sends the same text again. What varies is only whether the
     * reply is now visible in the SMS list, and the SERVER decides that, not this
     * client, so the message reports the outcome rather than the request.
     */
    @Test
    fun `reply message reports what the server did with the mirror`() = runTest(testDispatcher) {
        val vm = InboxViewModel(repository = mockRepo)

        assertEquals("Reply sent and added to this thread", vm.smsReplyResultMessage(true, ""))

        val newNumber = vm.smsReplyResultMessage(false, "no_existing_thread")
        assertTrue(newNumber.startsWith("Reply sent"))
        assertTrue(newNumber.contains("not added to the SMS list"))

        val brokenWrite = vm.smsReplyResultMessage(false, "write_failed")
        assertTrue(brokenWrite.startsWith("Reply sent"))

        // An older deployed function returns no reason at all. That must still
        // read as a sent reply, never as an error.
        assertEquals("Reply sent", vm.smsReplyResultMessage(false, ""))

        for (reason in listOf("", "not_requested", "no_existing_thread", "write_failed")) {
            val text = vm.smsReplyResultMessage(false, reason).lowercase()
            assertFalse(text.contains("failed to send"))
            assertFalse(text.contains("not sent"))
        }
    }
}
