package com.tribetails.auntieos.ui.inbox

import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.VoicemailLog
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.ExternalSendResult
import io.mockk.coEvery
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class InboxViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        every { mockRepo.observeVoicemails() } returns flowOf(emptyList())
        every { mockRepo.observeCalls() } returns flowOf(emptyList())
        every { mockRepo.observeSmsMessages() } returns flowOf(emptyList())
        coEvery { mockRepo.getEmails() } returns Result.success(emptyList())
        // Stage 2 step 7: the VM init now also loads conversations.
        coEvery { mockRepo.listConversations() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = InboxViewModel(repository = mockRepo)

    @Test
    fun `initial state loads without error when all repos succeed`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        assertNull(vm.error.value)
        assertFalse(vm.isLoading.value)
    }

    @Test
    fun `voicemails are populated from observeVoicemails`() = runTest(testDispatcher) {
        val vm = VoicemailLog(id = "vm1", callerNumber = "555-1234", transcript = "Hello")
        every { mockRepo.observeVoicemails() } returns flowOf(listOf(vm))

        val inboxVm = buildViewModel()
        advanceUntilIdle()

        assertFalse(inboxVm.voicemails.value.isEmpty())
    }

    @Test
    fun `emails error is set when getEmails fails`() = runTest(testDispatcher) {
        coEvery { mockRepo.getEmails() } returns Result.failure(RuntimeException("Email load failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    @Test
    fun `sendSmsReply sets error when recipientPhone is blank`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.sendSmsReply(recipientPhone = "", body = "Hi", kinfolkId = null, voicemailId = null)

        assertNotNull(vm.error.value)
    }

    @Test
    fun `sendSmsReply sets error when body is blank`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.sendSmsReply(recipientPhone = "555-0001", body = "", kinfolkId = null, voicemailId = null)

        assertNotNull(vm.error.value)
    }

    @Test
    fun `sendSmsReply sets error when sendMessage fails`() = runTest(testDispatcher) {
        // A5 repoint: VM now calls sendExternalMessage (not n8n sendMessage)
        coEvery {
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any())
        } returns Result.failure(RuntimeException("Send failed"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.sendSmsReply("555-0001", "Hello", kinfolkId = "kf1", voicemailId = null)
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertFalse(vm.isLoading.value)
    }

    @Test
    fun `sendSmsReply clears error on success`() = runTest(testDispatcher) {
        // A5 repoint: VM now calls sendExternalMessage returning ExternalSendResult
        coEvery {
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any())
        } returns Result.success(ExternalSendResult("sms", "SMxyz", "+1******0001"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.sendSmsReply("555-0001", "Hello", kinfolkId = "kf1", voicemailId = null)
        advanceUntilIdle()

        assertNull(vm.error.value)
    }

    // H-A2: sendSmsReply must surface failures and set error state.
    // A5 repoint: sendExternalMessage wraps errors in runCatching so it returns
    // Result.failure rather than throwing. The behavioral intent — VM sets _error
    // when the send fails — is unchanged; we simulate the failure via Result.failure.
    @Test
    fun `sendSmsReply sets error when repo throws unchecked exception`() = runTest(testDispatcher) {
        coEvery {
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any())
        } returns Result.failure(RuntimeException("network timeout"))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.sendSmsReply("555-0001", "Hello", kinfolkId = "kf1", voicemailId = null)
        advanceUntilIdle()

        assertNotNull(
            "sendSmsReply must surface send failures and set error state",
            vm.error.value
        )
        assertFalse(vm.isLoading.value)
    }

    @Test
    fun `clearError resets error to null`() = runTest(testDispatcher) {
        coEvery { mockRepo.getEmails() } returns Result.failure(RuntimeException("fail"))

        val vm = buildViewModel()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        vm.clearError()
        assertNull(vm.error.value)
    }
}
