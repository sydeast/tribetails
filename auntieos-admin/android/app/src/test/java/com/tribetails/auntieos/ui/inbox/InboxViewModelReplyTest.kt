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
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any())
        } returns Result.success(ExternalSendResult("sms", "SMxyz", "+1******2671"))

        val vm = InboxViewModel(repository = mockRepo)
        vm.sendSmsReply(recipientPhone = "+14155552671", body = "hi", kinfolkId = null, voicemailId = null)
        advanceUntilIdle()

        coVerify(exactly = 1) {
            mockRepo.sendExternalMessage(
                channel = "sms", to = "+14155552671", subject = null, body = "hi", transactional = true,
            )
        }
        coVerify(exactly = 0) { mockRepo.sendMessage(any()) }
    }
}
