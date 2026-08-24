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

    // Bulk "Mark all read". `bulkReadResult` holds the sentence the operator is
    // shown after a SUCCESSFUL clear; a failure goes to `conversationError` like
    // every other conversation failure, so the two can never be on screen at once.
    private val _bulkReadResult = MutableStateFlow<String?>(null)
    val bulkReadResult: StateFlow<String?> = _bulkReadResult.asStateFlow()

    private val _bulkReadInFlight = MutableStateFlow(false)
    val bulkReadInFlight: StateFlow<Boolean> = _bulkReadInFlight.asStateFlow()

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

    /**
     * Clears every thread waiting on a reply, server-side, then RE-READS the
     * list.
     *
     * There is no optimistic branch on purpose. The per-row unread dot and the
     * screen's unread count both read `unreadForAdmin` off `_conversations`, so
     * clearing them locally before the server agreed would show an empty inbox
     * for a write that failed. The count in the message is the server's own,
     * which also means a backlog larger than one call's bound reports what
     * really happened rather than "all of them".
     */
    fun markAllThreadsRead() {
        if (_bulkReadInFlight.value) return
        _bulkReadInFlight.value = true
        _bulkReadResult.value = null
        _conversationError.value = null
        viewModelScope.launch {
            repository.markAllThreadsRead()
                .onSuccess { cleared ->
                    _bulkReadInFlight.value = false
                    _bulkReadResult.value = bulkReadMessage(cleared)
                    loadConversations()
                }
                .onFailure {
                    _bulkReadInFlight.value = false
                    _conversationError.value =
                        "Could not mark all read: ${it.message ?: "Mark all read failed"}"
                }
        }
    }

    /** "1 thread marked read" / "N threads marked read". Pure. */
    internal fun bulkReadMessage(cleared: Int): String =
        if (cleared == 1) "1 thread marked read" else "$cleared threads marked read"

    fun clearBulkReadResult() { _bulkReadResult.value = null }

    fun clearConversationError() { _conversationError.value = null }

    fun refresh() {
        // Snapshot listeners stream updates automatically; keep method for pull-to-refresh UX.
        _isLoading.value = false
    }

    /**
     * What the operator is told after a reply goes out, matching the web admin's
     * banner word for word in substance.
     *
     * The send SUCCEEDED in every branch here. None of this may read as a failed
     * reply, because an operator who thinks a reply failed sends it a second time.
     * What differs is only whether the reply is now visible in the SMS channel
     * list: the server refuses to write that row for a number with no existing
     * thread, so promising one would send somebody looking for a row that was
     * never written.
     */
    internal fun smsReplyResultMessage(mirrored: Boolean, skippedReason: String): String = when {
        mirrored -> "Reply sent and added to this thread"
        skippedReason == "no_existing_thread" ->
            "Reply sent. This number has not texted in before, so it is not added to the SMS list"
        skippedReason == "write_failed" ->
            "Reply sent, but it could not be added to the SMS list"
        else -> "Reply sent"
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
                // Ask the server to also list this reply in the SMS channel. It
                // decides whether that is allowed; the message below reports what
                // it actually did, not what was asked for.
                mirrorToChannel = true,
            ).onSuccess { result ->
                if (!voicemailId.isNullOrBlank()) {
                    repository.markVoicemailReplied(voicemailId, result.providerMessageId).onFailure {
                        _error.value = it.message ?: "Reply sent but voicemail status update failed"
                    }
                }
                _actionResult.tryEmit(smsReplyResultMessage(result.mirrored, result.mirrorSkippedReason))
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

    /**
     * Dismisses a voicemail: it never needed an answer. Parity with the web
     * admin's Dismiss action, and the third ending a voicemail can have
     * alongside a reply and a read mark.
     *
     * Refresh works the way `markVoicemailRead` above documents: the live
     * `observeVoicemails` listener carries the new `replyStatus` back and the
     * row restyles itself, so nothing is refetched and nothing is guessed at
     * locally. A failure sets `_error` rather than emitting the success toast,
     * because a voicemail the operator believes they closed and that is still
     * `unread` is worse than one they know the app could not write.
     */
    fun markVoicemailDismissed(voicemailId: String) {
        if (voicemailId.isBlank()) {
            _error.value = "Cannot dismiss: this voicemail has no id"
            return
        }
        viewModelScope.launch {
            repository.markVoicemailDismissed(voicemailId)
                .onSuccess { _actionResult.tryEmit("Dismissed") }
                .onFailure { _error.value = it.message ?: "Failed to dismiss this voicemail" }
        }
    }

    fun clearError() { _error.value = null }
}
