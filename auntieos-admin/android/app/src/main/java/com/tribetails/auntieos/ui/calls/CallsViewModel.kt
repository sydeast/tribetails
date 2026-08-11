package com.tribetails.auntieos.ui.calls

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.CallEvent
import com.tribetails.auntieos.data.model.VoicemailEvent
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.CallEventStore
import com.tribetails.auntieos.util.VoicemailStore
import com.tribetails.auntieos.voice.AudioRoute
import com.tribetails.auntieos.voice.CallInviteManager
import com.tribetails.auntieos.voice.CallInviteManager.VoiceCallState
import com.tribetails.auntieos.voice.IncomingCallNotificationService
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.Instant

data class CallsUiState(
    val events: List<CallEvent>          = emptyList(),
    val voicemails: List<VoicemailEvent> = emptyList(),
    val messages: List<MessageEvent>     = emptyList(),
    val activeCall: CallEvent?           = null,
    val actionResult: String?            = null,
    val isActing: Boolean                = false,
    val voiceCallState: VoiceCallState   = VoiceCallState.Idle,
    val isMuted: Boolean                 = false,
    val isSpeakerOn: Boolean             = false,
    val isRefreshing: Boolean            = false
)

class CallsViewModel(
    private val appContext: Context,
    private val repository: AuntieRepository,
    // Same seam the domain repos use (see InvoiceRepository): a provider, resolved
    // lazily, so constructing the ViewModel never touches a Firebase singleton and a
    // unit test can hand in a mocked FirebaseFunctions.
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") }
) : ViewModel() {

    private val functions: FirebaseFunctions by lazy(functionsProvider)

    private val _actionResult     = MutableStateFlow<String?>(null)
    private val _isActing         = MutableStateFlow(false)
    private val _jumpToVoicemails = MutableStateFlow(false)
    private val _isRefreshing     = MutableStateFlow(false)

    /**
     * One event per completed [sendToVoicemail], carrying whether the server actually
     * took the action. A screen that has to DO something different on failure (the
     * lock-screen [CallScreenActivity] stays put instead of closing) needs more than
     * the human-readable [CallsUiState.actionResult] string.
     */
    private val _voicemailResults = MutableSharedFlow<Result<Unit>>(extraBufferCapacity = 4)
    val voicemailResults: SharedFlow<Result<Unit>> = _voicemailResults.asSharedFlow()

    private val callStatus: StateFlow<FourFlags> =
        combine(
            CallInviteManager.voiceCallState,
            _actionResult,
            _isActing,
            CallInviteManager.isMuted,
            CallInviteManager.isSpeakerOn
        ) { voiceState, actionResult, isActing, isMuted, isSpeakerOn ->
            FourFlags(
                voiceState = voiceState,
                result = actionResult,
                acting = isActing,
                muted = isMuted,
                speaker = isSpeakerOn
            )
        }.stateIn(
            viewModelScope,
            SharingStarted.Eagerly,
            FourFlags(
                voiceState = VoiceCallState.Idle,
                result = null,
                acting = false,
                muted = false,
                speaker = false
            )
        )

    val uiState: StateFlow<CallsUiState> =
        combine(
            combine(
                repository.observeCalls(),
                repository.observeVoicemails(),
                repository.observeSmsMessages(),
                CallEventStore.activeCall
            ) { callLogs, voicemails, smsMessages, activeCall ->
                Triple(
                    callLogs.map { it.toEvent() } to voicemails.map { it.toEvent() },
                    smsMessages.map { it.toEvent() } to activeCall,
                    Unit
                )
            },
            callStatus,
            _isRefreshing
        ) { dataTriple, status, isRefreshing ->
            val (eventsAndVoicemails, messagesAndActiveCall, _) = dataTriple
            val (events, voicemails) = eventsAndVoicemails
            val (messages, activeCall) = messagesAndActiveCall

            CallsUiState(
                events = events,
                voicemails = voicemails,
                messages = messages,
                activeCall = activeCall,
                actionResult = status.result,
                isActing = status.acting,
                voiceCallState = status.voiceState,
                isMuted = status.muted,
                isSpeakerOn = status.speaker,
                isRefreshing = isRefreshing
            )
        }.stateIn(viewModelScope, SharingStarted.Eagerly, CallsUiState())

    val jumpToVoicemails: StateFlow<Boolean> = _jumpToVoicemails.asStateFlow()

    init {
        AuntieLog.d("CallsViewModel initialized")

        viewModelScope.launch {
            VoicemailStore.navigateToVoicemails.collect { _jumpToVoicemails.value = true }
        }

        viewModelScope.launch {
            CallInviteManager.voiceCallState.collect { state ->
                AuntieLog.d("Voice call state changed: $state")
                if (state == VoiceCallState.Ended) {
                    IncomingCallNotificationService.stop(appContext)
                    CallEventStore.clearActiveCall()
                }
            }
        }
    }

    fun createKinfolkFromCall(event: CallEvent, name: String) {
        AuntieLog.i("Creating kinfolk from call: $name")
        viewModelScope.launch {
            _isActing.value = true
            val names = name.split(" ", limit = 2)
            val firstName = names.getOrElse(0) { "Unknown" }
            val lastName = names.getOrElse(1) { "" }
            repository.createKinfolk(firstName, lastName, event.callerNumber).onSuccess { kinfolk ->
                AuntieLog.i("Kinfolk created successfully from call")
                event.kinfolkName = kinfolk.displayName
                event.kinfolkId = kinfolk.id
                CallEventStore.updateEvent(event)
                _actionResult.value = "Kinfolk profile created for $name!"
            }.onFailure { e ->
                AuntieLog.e("Failed to create kinfolk from call", e)
                _actionResult.value = "Failed to create profile: ${e.message}"
            }
            _isActing.value = false
        }
    }

    fun consumeVoicemailJump() { _jumpToVoicemails.value = false }
    fun clearActionResult()    { _actionResult.value = null }
    fun dismissActiveCall()    { CallEventStore.clearActiveCall() }

    fun answerCall(context: Context) {
        AuntieLog.i("Answering call")
        CallInviteManager.answer(context)
        CallEventStore.resolveActiveCall("answered")
        IncomingCallNotificationService.start(context)
    }

    fun hangUp() {
        AuntieLog.i("Hanging up call")
        CallInviteManager.hangUp()
    }

    fun toggleMute() {
        AuntieLog.d("Toggling mute")
        CallInviteManager.setMuted(!CallInviteManager.isMuted.value)
    }

    fun toggleSpeaker(context: Context) {
        // Preserved as a no-arg-from-UI convenience used by tests and any old caller.
        // Internally now flips between Earpiece and Speaker through the 3-state API.
        val next = if (CallInviteManager.currentRoute.value == AudioRoute.Speaker) {
            AudioRoute.Earpiece
        } else {
            AudioRoute.Speaker
        }
        AuntieLog.d("Toggling speaker → $next")
        CallInviteManager.setRoute(context, next)
    }

    fun setRoute(context: Context, route: AudioRoute) {
        AuntieLog.d("Setting audio route → $route")
        CallInviteManager.setRoute(context, route)
    }

    fun clearAudioRouteError() {
        CallInviteManager.clearAudioRouteError()
    }

    val currentRoute: StateFlow<AudioRoute>
        get() = CallInviteManager.currentRoute

    val audioRouteError: StateFlow<String?>
        get() = CallInviteManager.audioRouteError

    fun availableRoutes(context: Context): Set<AudioRoute> =
        CallInviteManager.availableRoutes(context)

    /**
     * Rejects the ringing invite on this device, then tells the server to park the
     * caller in voicemail, and REPORTS WHAT ACTUALLY HAPPENED.
     *
     * The old version fired a bare-OkHttp GET at a retired Twilio Serverless host,
     * threw the response away with `.execute().close()`, swallowed every exception,
     * and then said "Caller sent to voicemail." either way. Against a dead host that
     * is a lie the operator has no way to see: the caller kept ringing into nothing
     * while the phone said the voicemail hand-off worked.
     *
     * [CallEventStore.resolveActiveCall] runs on BOTH paths on purpose. The local
     * reject already ended the invite, so leaving the ringing banner up would be its
     * own falsehood; what differs is the message and the [voicemailResults] outcome.
     */
    fun sendToVoicemail(callSid: String) {
        AuntieLog.i("Sending call $callSid to voicemail")
        viewModelScope.launch {
            _isActing.value = true
            CallInviteManager.reject(appContext)

            val outcome = runCatching {
                functions
                    .getHttpsCallable(SCREEN_CALL_ACTION)
                    .call(mapOf("callSid" to callSid, "action" to ACTION_REJECT))
                    .await()
                Unit
            }

            CallEventStore.resolveActiveCall("rejected")

            outcome.onSuccess {
                _actionResult.value = "Caller sent to voicemail."
            }.onFailure { e ->
                AuntieLog.e("screenCallAction reject failed for $callSid", e)
                _actionResult.value =
                    "Could not send the caller to voicemail: ${e.message ?: "the server did not answer"}"
            }
            _voicemailResults.tryEmit(outcome)
            _isActing.value = false
        }
    }

    fun refresh() {
        AuntieLog.d("Refreshing call data")
        viewModelScope.launch {
            _isRefreshing.value = true
            try {
                kotlinx.coroutines.delay(1000)
            } finally {
                _isRefreshing.value = false
            }
        }
    }

    companion object {
        /** Server callable that screens a ringing call. Args: { callSid, action }. */
        const val SCREEN_CALL_ACTION = "screenCallAction"
        const val ACTION_REJECT      = "reject"
    }

    private data class FourFlags(
        val voiceState: VoiceCallState,
        val result: String?,
        val acting: Boolean,
        val muted: Boolean,
        val speaker: Boolean
    )
}

private fun parseIsoToMillis(iso: String): Long = runCatching {
    Instant.parse(iso).toEpochMilli()
}.getOrElse { System.currentTimeMillis() }

private fun CallLog.toEvent(): CallEvent = CallEvent(
    callSid = twilioCallSid.ifBlank { id },
    callerNumber = counterpartNumber,
    transcript = transcript,
    popupUrl = recordingUrl,
    timestamp = parseIsoToMillis(timestamp),
    actionTaken = when (status.lowercase()) {
        "answered" -> "answered"
        "declined", "rejected", "voicemail", "missed" -> "rejected"
        else -> "no_response"
    },
    recordingUrl = recordingUrl,
    kinfolkName = kinfolkName.takeIf { it.isNotBlank() },
    kinfolkId = kinfolkId
)

private fun VoicemailLog.toEvent(): VoicemailEvent = VoicemailEvent(
    callerNumber = callerNumber,
    transcript = transcript,
    playUrl = audioUrl,
    timestamp = parseIsoToMillis(timestamp),
    kinfolkName = kinfolkName.takeIf { it.isNotBlank() },
    kinfolkId = kinfolkId
)

private fun SmsMessage.toEvent(): MessageEvent = MessageEvent(
    messageSid = twilioMessageSid.ifBlank { id },
    body = body,
    senderNumber = counterpartNumber,
    type = subType,
    timestamp = parseIsoToMillis(timestamp),
    direction = direction,
    kinfolkName = kinfolkName.takeIf { it.isNotBlank() },
    kinfolkId = kinfolkId
)

