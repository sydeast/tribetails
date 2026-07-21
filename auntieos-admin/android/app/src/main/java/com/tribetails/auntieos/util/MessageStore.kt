package com.tribetails.auntieos.util

import com.tribetails.auntieos.data.model.MessageEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

object MessageStore {

    private val _messages = MutableStateFlow<List<MessageEvent>>(emptyList())
    val messages: StateFlow<List<MessageEvent>> = _messages.asStateFlow()

    private val _navigateToMessages = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val navigateToMessages: SharedFlow<Unit> = _navigateToMessages.asSharedFlow()

    fun addMessage(message: MessageEvent) {
        _messages.update { listOf(message) + it }
        _navigateToMessages.tryEmit(Unit)
    }

    fun updateMessage(message: MessageEvent) {
        _messages.update { list ->
            list.map { if (it.messageSid == message.messageSid) message else it }
        }
    }
}
