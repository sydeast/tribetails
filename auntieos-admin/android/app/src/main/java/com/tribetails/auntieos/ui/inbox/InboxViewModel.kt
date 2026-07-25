package com.tribetails.auntieos.ui.inbox

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.CallLog
import com.tribetails.auntieos.data.model.EmailMessage
import com.tribetails.auntieos.data.model.SmsMessage
import com.tribetails.auntieos.data.model.VoicemailLog
import com.tribetails.auntieos.data.repository.AuntieRepository
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Backs the Android InboxScreen. Holds four parallel lists (one per channel)
 * and a single isLoading flag flipped while ANY of the four loads is in flight.
 *
 * Mirrors the structure of the web Inbox screen so when the Android app pivots
 * to Compose Multiplatform, the screens drop straight in.
 */
class InboxViewModel(private val repository: AuntieRepository) : ViewModel() {

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _voicemails = MutableStateFlow<List<VoicemailLog>>(emptyList())
    val voicemails: StateFlow<List<VoicemailLog>> = _voicemails.asStateFlow()

    private val _calls = MutableStateFlow<List<CallLog>>(emptyList())
    val calls: StateFlow<List<CallLog>> = _calls.asStateFlow()

    private val _sms = MutableStateFlow<List<SmsMessage>>(emptyList())
    val sms: StateFlow<List<SmsMessage>> = _sms.asStateFlow()

    private val _emails = MutableStateFlow<List<EmailMessage>>(emptyList())
    val emails: StateFlow<List<EmailMessage>> = _emails.asStateFlow()

    private val _actionResult = MutableSharedFlow<String>(extraBufferCapacity = 1)
    val actionResult = _actionResult

    // ── Stage 2 step 7: conversations (Message Auntie) ───────────────────────
    private val _conversations = MutableStateFlow<List<ConversationSummary>>(emptyList())
    val conversations: StateFlow<List<ConversationSummary>> = _conversations.asStateFlow()

    private val _conversationsLoading = MutableStateFlow(false)
    val conversationsLoading: StateFlow<Boolean> = _conversationsLoading.asStateFlow()

    private val _selectedConversationId = MutableStateFlow<String?>(null)
    val selectedConversationId: StateFlow<String?> = _selectedConversationId.asStateFlow()

    private val _thread = MutableStateFlow<List<ThreadMessage>>(emptyList())
    val thread: StateFlow<List<ThreadMessage>> = _thread.asStateFlow()

    private val _threadLoading = MutableStateFlow(false)
    val threadLoading: StateFlow<Boolean> = _threadLoading.asStateFlow()

    private val _conversationError = MutableStateFlow<String?>(null)
    val conversationError: StateFlow<String?> = _conversationError.asStateFlow()

    private val _isReplying = MutableStateFlow(false)
    val isReplying: StateFlow<Boolean> = _isReplying.asStateFlow()

    init {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            repository.observeVoicemails().collect {
                _voicemails.value = it
                _isLoading.value = false
            }
        }
        viewModelScope.launch {
            repository.observeCalls().collect { _calls.value = it }
        }
        viewModelScope.launch {
            repository.observeSmsMessages().collect { _sms.value = it }
        }
        // Email is a LIVE stream now, like its three sibling channels, rather
        // than an unbounded one-shot `getEmails()`. `catch` is what keeps a
        // failing listener fail-LOUD rather than fail-fatal: the repository
        // closes the flow with the Firestore error, and without this the
        // exception would escape the collect and take the coroutine down,
        // leaving the screen with no rows and no explanation.
        viewModelScope.launch {
            repository.observeEmails()
                .catch { _error.value = _error.value ?: (it.message ?: "Failed to load emails") }
                .collect { _emails.value = it }
        }
        loadConversations()
    }

    fun loadConversations() {
        viewModelScope.launch {
            _conversationsLoading.value = true
            repository.listConversations()
                .onSuccess { _conversations.value = it; _conversationsLoading.value = false }
                .onFailure {
                    _conversationsLoading.value = false
                    _conversationError.value = "Could not load messages: ${it.message}"
                }
        }
    }

    fun openConversation(kinfolkId: String) {
        if (_selectedConversationId.value == kinfolkId) {
            _selectedConversationId.value = null
            return
        }
        _selectedConversationId.value = kinfolkId
        _thread.value = emptyList()
        _conversationError.value = null
        _threadLoading.value = true
        viewModelScope.launch {
            repository.getConversationThread(kinfolkId)
                .onSuccess { _thread.value = it; _threadLoading.value = false }
                .onFailure { _threadLoading.value = false; _conversationError.value = it.message ?: "Could not load thread" }
            loadConversations() // clears the unread badge after opening
        }
    }

    fun sendReply(body: String) {
        val id = _selectedConversationId.value ?: return
        val problem = replyBlocker(body)
        if (problem != null) { _conversationError.value = problem; return }
        if (_isReplying.value) return
        _isReplying.value = true
        _conversationError.value = null
        viewModelScope.launch {
            repository.replyToConversation(id, body.trim())
                .onSuccess {
                    _isReplying.value = false
                    _actionResult.tryEmit("Reply sent")
                    openConversationRefresh(id)
                }
                .onFailure { _isReplying.value = false; _conversationError.value = it.message ?: "Reply failed" }
        }
    }

    /** Re-fetches a thread already open (after a reply) without toggling selection. */
    private fun openConversationRefresh(kinfolkId: String) {
        _threadLoading.value = true
        viewModelScope.launch {
            repository.getConversationThread(kinfolkId)
                .onSuccess { _thread.value = it; _threadLoading.value = false }
                .onFailure { _threadLoading.value = false; _conversationError.value = it.message ?: "Could not refresh thread" }
            loadConversations()
        }
    }

    fun clearConversationError() { _conversationError.value = null }

    fun refresh() {
        // Snapshot listeners stream updates automatically; keep method for pull-to-refresh UX.
        _isLoading.value = false
    }

    fun sendSmsReply(
        recipientPhone: String,
        body: String,
        kinfolkId: String?,
        voicemailId: String?
    ) {
        if (recipientPhone.isBlank()) {
            _error.value = "Cannot reply: missing recipient phone number"
            return
        }
        if (body.isBlank()) {
            _error.value = "Cannot reply: message body is blank"
            return
        }

        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            repository.sendExternalMessage(
                channel = "sms",
                to = recipientPhone,
                subject = null,
                body = body,
                transactional = true,
            ).onSuccess { result ->
                if (!voicemailId.isNullOrBlank()) {
                    repository.markVoicemailReplied(voicemailId, result.providerMessageId).onFailure {
                        _error.value = it.message ?: "Reply sent but voicemail status update failed"
                    }
                }
                _actionResult.tryEmit("Reply sent")
            }.onFailure { _error.value = it.message ?: "Failed to send reply" }
            _isLoading.value = false
        }
    }

    /**
     * Marks a voicemail read, for one the operator listened to and does not
     * need to answer. Parity with the web admin's Mark read action.
     *
     * The live `observeVoicemails` listener carries the new state back on its
     * own, so nothing is refetched here and the row restyles itself. A failure
     * is surfaced, never swallowed: a voicemail that silently stayed unread
     * would keep appearing as work that is waiting.
     */
    fun markVoicemailRead(voicemailId: String) {
        if (voicemailId.isBlank()) {
            _error.value = "Cannot mark read: this voicemail has no id"
            return
        }
        viewModelScope.launch {
            repository.markVoicemailRead(voicemailId)
                .onSuccess { _actionResult.tryEmit("Marked read") }
                .onFailure { _error.value = it.message ?: "Failed to mark this voicemail read" }
        }
    }

    fun clearError() { _error.value = null }
}
