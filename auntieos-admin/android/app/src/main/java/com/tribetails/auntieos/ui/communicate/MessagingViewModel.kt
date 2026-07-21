package com.tribetails.auntieos.ui.communicate

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.MessageEvent
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.time.Instant

data class MessagingUiState(
    val messages: List<MessageEvent> = emptyList(),
    val selectedKinfolk: Kinfolk? = null,
    val currentInput: String = "",
    val isSending: Boolean = false,
    val error: String? = null
)

class MessagingViewModel(private val repo: AuntieRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(MessagingUiState())
    val uiState: StateFlow<MessagingUiState> = _uiState.asStateFlow()

    private var allSmsMessages: List<SmsMessage> = emptyList()

    init {
        AuntieLog.d("MessagingViewModel initialized")
        viewModelScope.launch {
            repo.observeSmsMessages().collect { messages ->
                allSmsMessages = messages
                updateMessageList(messages)
            }
        }
    }

    fun selectKinfolk(kinfolk: Kinfolk?) {
        AuntieLog.d("Kinfolk selected for messaging: ${kinfolk?.displayName ?: "none"}")
        _uiState.update { it.copy(selectedKinfolk = kinfolk) }
        updateMessageList(allSmsMessages)
    }

    private fun updateMessageList(allMessages: List<SmsMessage>) {
        val kinfolk = _uiState.value.selectedKinfolk
        if (kinfolk == null) {
            _uiState.update { it.copy(messages = emptyList()) }
            return
        }
        
        // Filter messages for the selected kinfolk by phone number
        val filtered = allMessages.filter {
            it.counterpartNumber == kinfolk.phoneNumber || it.kinfolkId == kinfolk.id
        }.sortedByDescending { it.timestamp }
            .map { it.toEvent() }

        AuntieLog.d("Filtered ${filtered.size} messages for ${kinfolk.firstName}")
        _uiState.update { it.copy(messages = filtered) }
    }

    fun onInputChange(text: String) {
        _uiState.update { it.copy(currentInput = text) }
    }

    fun sendMessage() {
        val state = _uiState.value
        val kinfolk = state.selectedKinfolk ?: return
        val body = state.currentInput
        if (body.isBlank()) {
            AuntieLog.w("Attempted to send blank message")
            _uiState.update { it.copy(error = "Message cannot be empty.") }
            return
        }

        AuntieLog.i("Sending message to ${kinfolk.firstName}: ${body.take(20)}...")
        viewModelScope.launch {
            _uiState.update { it.copy(isSending = true, error = null) }
            repo.sendExternalMessage(
                channel = "sms",
                to = kinfolk.phoneNumber,
                subject = null,
                body = body,
                transactional = true,
            ).onSuccess {
                AuntieLog.i("Message sent successfully")
                _uiState.update { it.copy(isSending = false, currentInput = "") }
            }.onFailure { e ->
                AuntieLog.e("Failed to send message", e)
                _uiState.update { it.copy(isSending = false, error = e.message ?: "Failed to send") }
            }
        }
    }

    fun clearError() {
        _uiState.update { it.copy(error = null) }
    }
}

private fun SmsMessage.toEvent(): MessageEvent = MessageEvent(
    messageSid = twilioMessageSid.ifBlank { id },
    body = body,
    senderNumber = counterpartNumber,
    type = subType,
    timestamp = runCatching { Instant.parse(timestamp).toEpochMilli() }.getOrElse { System.currentTimeMillis() },
    direction = direction,
    kinfolkName = kinfolkName.takeIf { it.isNotBlank() },
    kinfolkId = kinfolkId
)

