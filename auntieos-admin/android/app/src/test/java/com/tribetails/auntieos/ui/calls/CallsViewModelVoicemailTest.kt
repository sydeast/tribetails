package com.tribetails.auntieos.ui.calls

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import com.tribetails.auntieos.data.model.CallEvent
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.util.CallEventStore
import com.tribetails.auntieos.voice.CallInviteManager
import io.mockk.CapturingSlot
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.runs
import io.mockk.slot
import io.mockk.unmockkObject
import io.mockk.verify
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
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

/**
 * `sendToVoicemail` used to GET a retired Twilio Serverless URL with a bare
 * `OkHttpClient()`, drop the response on the floor with `.execute().close()`,
 * swallow every exception, and then set the result to "Caller sent to voicemail."
 * no matter what came back. Every caller of a dead host was told it worked.
 *
 * These cases pin the three things that were wrong: the result is checked, a
 * failure reads as a failure, and the call goes to the `screenCallAction` callable
 * under the argument names the server expects. The last one matters as much as the
 * first two, because a mistyped callable name is a production-only failure that no
 * test mocking a layer higher can see.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class CallsViewModelVoicemailTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var repository: AuntieRepository
    private lateinit var context: Context

    private val ringingCall = CallEvent(
        callSid = "CA-ringing",
        callerNumber = "+15125550100",
        transcript = "Calling about Rufus",
        popupUrl = "",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)

        // uiState collects these eagerly, so a bare relaxed mock's fake Flow would
        // blow up the moment the ViewModel is constructed.
        repository = mockk()
        every { repository.observeCalls(any()) } returns flowOf(emptyList())
        every { repository.observeVoicemails(any()) } returns flowOf(emptyList())
        every { repository.observeSmsMessages(any()) } returns flowOf(emptyList())

        context = mockk(relaxed = true)

        // Rejecting the invite reaches the Twilio Voice SDK. What is under test is
        // everything that happens AFTER the local reject, so stub it out.
        mockkObject(CallInviteManager)
        every { CallInviteManager.reject(any()) } just runs

        CallEventStore.addEvent(ringingCall)
    }

    @After
    fun tearDown() {
        CallEventStore.clearActiveCall()
        unmockkObject(CallInviteManager)
        Dispatchers.resetMain()
    }

    /** A [FirebaseFunctions] whose `screenCallAction` callable answers with [answer]. */
    private fun functionsAnswering(
        answer: Task<HttpsCallableResult>,
        payload: CapturingSlot<Any>?,
    ): FirebaseFunctions {
        val functions = mockk<FirebaseFunctions>()
        val callable = mockk<HttpsCallableReference>()
        if (payload == null) {
            every { callable.call(any()) } returns answer
        } else {
            every { callable.call(capture(payload)) } returns answer
        }
        every { functions.getHttpsCallable(CallsViewModel.SCREEN_CALL_ACTION) } returns callable
        return functions
    }

    private fun succeedingFunctions(payload: CapturingSlot<Any>? = null): FirebaseFunctions {
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns mapOf("ok" to true)
        return functionsAnswering(Tasks.forResult(callResult), payload)
    }

    private fun failingFunctions(message: String = "UNAVAILABLE"): FirebaseFunctions =
        functionsAnswering(Tasks.forException(RuntimeException(message)), payload = null)

    private fun buildViewModel(functions: FirebaseFunctions) =
        CallsViewModel(context, repository, functionsProvider = { functions })

    @Test
    fun `a failed screening action is reported as a failure, not as success`() = runTest(testDispatcher) {
        val vm = buildViewModel(failingFunctions("host is gone"))

        vm.sendToVoicemail(ringingCall.callSid)
        advanceUntilIdle()

        val message = vm.uiState.value.actionResult
        assertNotNull("a failed hand-off has to say something", message)
        assertFalse(
            "the old code claimed success against a dead host: $message",
            message!!.contains("Caller sent to voicemail"),
        )
        assertTrue("the message has to name the failure: $message", message.contains("Could not send"))
        assertTrue("the server's own reason belongs in the message: $message", message.contains("host is gone"))
    }

    @Test
    fun `a failed screening action emits a failed outcome`() = runTest(testDispatcher) {
        val vm = buildViewModel(failingFunctions())
        val outcomes = mutableListOf<Result<Unit>>()
        backgroundScope.launch { vm.voicemailResults.collect { outcomes += it } }

        vm.sendToVoicemail(ringingCall.callSid)
        advanceUntilIdle()

        assertEquals(1, outcomes.size)
        assertTrue("the lock screen must not close on this", outcomes.first().isFailure)
    }

    @Test
    fun `success is reported only when the callable actually succeeds`() = runTest(testDispatcher) {
        val vm = buildViewModel(succeedingFunctions())
        val outcomes = mutableListOf<Result<Unit>>()
        backgroundScope.launch { vm.voicemailResults.collect { outcomes += it } }

        vm.sendToVoicemail(ringingCall.callSid)
        advanceUntilIdle()

        assertEquals("Caller sent to voicemail.", vm.uiState.value.actionResult)
        assertEquals(1, outcomes.size)
        assertTrue(outcomes.first().isSuccess)
    }

    @Test
    fun `the ringing banner clears and the spinner stops on both outcomes`() = runTest(testDispatcher) {
        val failing = buildViewModel(failingFunctions())
        failing.sendToVoicemail(ringingCall.callSid)
        advanceUntilIdle()

        // The local reject already ended the invite, so a stuck "ringing" banner
        // would be its own falsehood. What differs between the paths is the message.
        assertNull(CallEventStore.activeCall.value)
        assertFalse(failing.uiState.value.isActing)

        CallEventStore.addEvent(ringingCall)
        val succeeding = buildViewModel(succeedingFunctions())
        succeeding.sendToVoicemail(ringingCall.callSid)
        advanceUntilIdle()

        assertNull(CallEventStore.activeCall.value)
        assertFalse(succeeding.uiState.value.isActing)
    }

    @Test
    fun `it calls screenCallAction by name with the call sid and a reject action`() = runTest(testDispatcher) {
        val payload = slot<Any>()
        val functions = succeedingFunctions(payload)

        buildViewModel(functions).sendToVoicemail("CA-wire")
        advanceUntilIdle()

        verify(exactly = 1) { functions.getHttpsCallable("screenCallAction") }
        @Suppress("UNCHECKED_CAST")
        val sent = payload.captured as Map<String, Any?>
        assertEquals(setOf("callSid", "action"), sent.keys)
        assertEquals("CA-wire", sent["callSid"])
        assertEquals("reject", sent["action"])
    }
}
