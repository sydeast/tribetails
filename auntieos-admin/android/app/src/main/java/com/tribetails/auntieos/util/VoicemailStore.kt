package com.tribetails.auntieos.util

import com.tribetails.auntieos.data.model.VoicemailEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object VoicemailStore {

    private val _voicemails = MutableStateFlow<List<VoicemailEvent>>(emptyList())
    val voicemails: StateFlow<List<VoicemailEvent>> = _voicemails.asStateFlow()

    private val _navigateToVoicemails = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val navigateToVoicemails: SharedFlow<Unit> = _navigateToVoicemails.asSharedFlow()

    fun addVoicemail(vm: VoicemailEvent) {
        _voicemails.update { listOf(vm) + it }
        _navigateToVoicemails.tryEmit(Unit)
    }

    fun updateVoicemail(vm: VoicemailEvent) {
        _voicemails.update { list ->
            list.map { if (it.timestamp == vm.timestamp && it.callerNumber == vm.callerNumber) vm else it }
        }
    }
}
