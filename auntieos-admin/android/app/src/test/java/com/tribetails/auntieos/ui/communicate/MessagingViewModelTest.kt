package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.SmsMessage
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MessagingViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        every { mockRepo.observeSmsMessages() } returns flowOf(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = MessagingViewModel(repo = mockRepo)

    @Test
    fun `initial state has no messages and no selected kinfolk`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue(state.messages.isEmpty())
        assertNull(state.selectedKinfolk)
        assertNull(state.error)
    }

    @Test
    fun `selectKinfolk filters messages for that kinfolk by id`() = runTest(testDispatcher) {
        val sms = SmsMessage(
            id = "sms1",
            kinfolkId = "kf1",
            counterpartNumber = "555-0001",
            body = "Hello!",
            direction = "inbound",
            timestamp = "2026-05-01T10:00:00Z"
        )
        every { mockRepo.observeSmsMessages() } returns flowOf(listOf(sms))

        val vm = buildViewModel()
        advanceUntilIdle()

        vm.selectKinfolk(TestFixtures.kinfolk1)
        advanceUntilIdle()

        assertEquals(1, vm.uiState.value.messages.size)
    }

    @Test
    fun `selectKinfolk null clears messages`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.selectKinfolk(TestFixtures.kinfolk1)
        vm.selectKinfolk(null)

        assertTrue(vm.uiState.value.messages.isEmpty())
    }

    @Test
    fun `onInputChange updates currentInput`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.onInputChange("Hello Biscuit!")
        assertEquals("Hello Biscuit!", vm.uiState.value.currentInput)
    }

    @Test
    fun `sendMessage clears input on success`() = runTest(testDispatcher) {
        // A5 repoint: VM now calls sendExternalMessage (not n8n sendMessage)
        coEvery {
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any())
        } returns Result.success(ExternalSendResult("sms", "SMxyz", "+1******0001"))

        val vm = buildViewModel()
        vm.selectKinfolk(TestFixtures.kinfolk1)
        vm.onInputChange("Great walk today!")
        vm.sendMessage()
        advanceUntilIdle()

        assertEquals("", vm.uiState.value.currentInput)
        assertFalse(vm.uiState.value.isSending)
        assertNull(vm.uiState.value.error)
    }

    @Test
    fun `sendMessage sets error on failure`() = runTest(testDispatcher) {
        // A5 repoint: VM now calls sendExternalMessage (not n8n sendMessage)
        coEvery {
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any())
        } returns Result.failure(RuntimeException("Send failed"))

        val vm = buildViewModel()
        vm.selectKinfolk(TestFixtures.kinfolk1)
        vm.onInputChange("Hello")
        vm.sendMessage()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        assertFalse(vm.uiState.value.isSending)
    }

    @Test
    fun `sendMessage does nothing when no kinfolk selected`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.onInputChange("Hello")
        vm.sendMessage()

        assertFalse(vm.uiState.value.isSending)
    }

    @Test
    fun `sendMessage sets error and does not send when body is whitespace-only`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.selectKinfolk(TestFixtures.kinfolk1)
        vm.onInputChange("   ")
        vm.sendMessage()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isSending)
        assertNotNull(
            "Expected error when sending whitespace-only message (Fail Loud)",
            vm.uiState.value.error
        )
    }

    @Test
    fun `clearError resets error to null`() = runTest(testDispatcher) {
        // A5 repoint: VM now calls sendExternalMessage (not n8n sendMessage)
        coEvery {
            mockRepo.sendExternalMessage(any(), any(), any(), any(), any())
        } returns Result.failure(RuntimeException("fail"))

        val vm = buildViewModel()
        vm.selectKinfolk(TestFixtures.kinfolk1)
        vm.onInputChange("hi")
        vm.sendMessage()
        advanceUntilIdle()

        assertNotNull(vm.uiState.value.error)
        vm.clearError()
        assertNull(vm.uiState.value.error)
    }
}
