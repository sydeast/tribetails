package com.tribetails.auntieos.ui.calls

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
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

    /** Owns every ViewModel this class builds, so [tearDown] can cancel them. */
    private val viewModelStore = ViewModelStore()

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
        // BEFORE resetMain, and the order is the fix. Clearing the store cancels
        // viewModelScope, and that cancellation has to run while the test's main
        // dispatcher is still installed. Reset first and the cancellation itself
        // would need the dispatcher it just removed.
        viewModelStore.clear()
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

    /**
     * Builds the ViewModel through a [ViewModelStore] so [tearDown] can cancel it.
     *
     * NOT a style preference. `CallsViewModel.init` launches an unbounded
     * `CallInviteManager.voiceCallState.collect` on `viewModelScope`, and that
     * flow is a StateFlow on a process-wide `object`, so it outlives any single
     * test. Constructing the ViewModel directly and walking away left a live
     * collector subscribed to it after this class called `Dispatchers.resetMain()`.
     *
     * The next plain-JVM test in the same Gradle worker to WRITE that flow then
     * had to resume that orphan on a main dispatcher that no longer existed, and
     * failed with `DispatchException` for a reason that had nothing to do with
     * it. It surfaced in `CallInviteManagerTest` one class away, and only on a
     * full `--rerun-tasks` run rather than per-class, which is exactly why this
     * class's own CI was green while it was leaking.
     *
     * `ViewModelStore.clear()` is the supported way to reach `viewModelScope`
     * cancellation from a unit test.
     */
    private fun buildViewModel(functions: FirebaseFunctions): CallsViewModel {
        val factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                CallsViewModel(context, repository, functionsProvider = { functions }) as T
        }
        return ViewModelProvider(viewModelStore, factory)[CallsViewModel::class.java]
    }

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

    /**
     * Pins the leak fix itself, rather than trusting that [tearDown] does its job.
     *
     * A ViewModel this class built must be genuinely DEAD once the store is
     * cleared. If `viewModelScope` survived, so would the
     * `CallInviteManager.voiceCallState` collector started in `init`, and it
     * would go on to poison an unrelated test class in the same Gradle worker.
     *
     * `sendToVoicemail` is the observable proxy: it does its work inside
     * `viewModelScope`, so a cancelled scope means the callable is never
     * reached. Asserted through a public entry point on purpose, because
     * reaching into the scope directly would test the framework rather than
     * this class's disposal of it.
     */
    @Test
    fun `a cleared ViewModel is dead, which is what stops it leaking into the next test`() =
        runTest(testDispatcher) {
            val functions = succeedingFunctions()
            val vm = buildViewModel(functions)

            // Alive: the call goes out.
            vm.sendToVoicemail("CA-before-clear")
            advanceUntilIdle()
            verify(exactly = 1) { functions.getHttpsCallable("screenCallAction") }

            viewModelStore.clear()

            // Dead: nothing further reaches the wire, because the scope is gone.
            vm.sendToVoicemail("CA-after-clear")
            advanceUntilIdle()
            verify(exactly = 1) { functions.getHttpsCallable("screenCallAction") }
        }
}
