package com.tribetails.auntieos.util

import com.tribetails.auntieos.data.model.CallEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object CallEventStore {

    private val _events = MutableStateFlow<List<CallEvent>>(emptyList())
    val events: StateFlow<List<CallEvent>> = _events.asStateFlow()

    private val _activeCall = MutableStateFlow<CallEvent?>(null)
    val activeCall: StateFlow<CallEvent?> = _activeCall.asStateFlow()

    private val _navigateToCalls = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val navigateToCalls: SharedFlow<Unit> = _navigateToCalls.asSharedFlow()

    fun addEvent(event: CallEvent) {
        _events.update { listOf(event) + it }
        _activeCall.value = event
        _navigateToCalls.tryEmit(Unit)
    }

    fun updateEvent(event: CallEvent) {
        _events.update { list ->
            list.map { if (it.callSid == event.callSid) event else it }
        }
    }

    /** Links the call [callSid] to the household created from it (#829). */
    fun linkKinfolk(callSid: String, kinfolkId: String, kinfolkName: String) {
        _events.update { list ->
            list.map { if (it.callSid == callSid) it.copy(kinfolkId = kinfolkId, kinfolkName = kinfolkName) else it }
        }
    }

    fun resolveActiveCall(action: String) {
        val active = _activeCall.value ?: return
        _events.update { list ->
            list.map { if (it.callSid == active.callSid) it.copy(actionTaken = action) else it }
        }
        _activeCall.value = null
    }

    fun updateCallRecording(callSid: String, recordingUrl: String) {
        _events.update { list ->
            list.map { if (it.callSid == callSid) it.copy(recordingUrl = recordingUrl) else it }
        }
    }

    fun clearActiveCall() {
        _activeCall.value = null
    }
}
