package com.tribetails.auntieos.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** UI state for the Activity Log hash-chain verification action. */
sealed interface ChainVerifyUiState {
    data object Idle : ChainVerifyUiState
    data object Loading : ChainVerifyUiState
    data class Done(val result: com.tribetails.auntieos.data.admin.ChainVerifyResult) : ChainVerifyUiState
    data class Error(val message: String) : ChainVerifyUiState
}

/**
 * W4-1: the invoice and payment paths inject [InvoiceRepository] directly.
 * [repository] still serves this screen's other ~20 domains, which are carved
 * in later waves.
 */
class AdminDataViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    private val invoiceRepository: InvoiceRepository = AuntieOSApp.instance.invoiceRepository,
    // W4-3: the Auntie Time session list, its row patches and the KinTale
    // buckets (including orphan triage) are KinCare domain.
    private val kinCareRepository: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
) : ViewModel() {

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    // Invoice Management
    private val _invoices = MutableStateFlow<List<Invoice>>(emptyList())
    val invoices: StateFlow<List<Invoice>> = _invoices.asStateFlow()

    // Payment Management
    private val _payments = MutableStateFlow<List<Payment>>(emptyList())
    val payments: StateFlow<List<Payment>> = _payments.asStateFlow()

    // Visit Log Management
    private val _visitLogs = MutableStateFlow<List<VisitLog>>(emptyList())
    val visitLogs: StateFlow<List<VisitLog>> = _visitLogs.asStateFlow()

    // Training Document Management
    private val _trainingDocuments = MutableStateFlow<List<TrainingDocument>>(emptyList())
    val trainingDocuments: StateFlow<List<TrainingDocument>> = _trainingDocuments.asStateFlow()

    // Kin Care Session Management
    private val _kinCareSessions = MutableStateFlow<List<KinCareSession>>(emptyList())
    val kinCareSessions: StateFlow<List<KinCareSession>> = _kinCareSessions.asStateFlow()

    // §A.8: Business-Settings time blocks for the Auntie-Time "Evening block" labels.
    // Unified settings (2026-06-05): timeBlocks now live on business_settings,
    // read via the injected AuntieRepository.
    private val _timeBlocks = MutableStateFlow<List<com.tribetails.auntieos.data.model.TimeBlockDefinition>>(emptyList())
    val timeBlocks: StateFlow<List<com.tribetails.auntieos.data.model.TimeBlockDefinition>> = _timeBlocks.asStateFlow()

    // KinTale (visit recap report) Management
    private val _kinCareReports = MutableStateFlow<List<KinCareReport>>(emptyList())
    val kinCareReports: StateFlow<List<KinCareReport>> = _kinCareReports.asStateFlow()

    // Kinfolk list - populated on demand by orphan triage flow so the
    // "Assign Kinfolk" picker has live data without loading the directory
    // every time the logs screen opens.
    private val _kinfolkDirectory = MutableStateFlow<List<Kinfolk>>(emptyList())
    val kinfolkDirectory: StateFlow<List<Kinfolk>> = _kinfolkDirectory.asStateFlow()

    // Last orphan triage action result. UI watches this flow to render
    // success / error toasts. Cleared by `clearTriageResult()`.
    private val _triageResult = MutableStateFlow<TriageResult?>(null)
    val triageResult: StateFlow<TriageResult?> = _triageResult.asStateFlow()

    data class TriageResult(val success: Boolean, val message: String)

    // Activity log (audit trail) Management
    private val _activityLog = MutableStateFlow<List<com.tribetails.auntieos.data.admin.ActivityLogEntry>>(emptyList())
    val activityLog: StateFlow<List<com.tribetails.auntieos.data.admin.ActivityLogEntry>> = _activityLog.asStateFlow()

    // Hash-chain integrity verdict (calls the deployed verifyActivityLogChain
    // admin callable). Parity with the web Activity Log chain-verify panel.
    private val _chainVerify = MutableStateFlow<ChainVerifyUiState>(ChainVerifyUiState.Idle)
    val chainVerify: StateFlow<ChainVerifyUiState> = _chainVerify.asStateFlow()

    fun verifyChain() {
        _chainVerify.value = ChainVerifyUiState.Loading
        viewModelScope.launch {
            repository.verifyActivityLogChain()
                .onSuccess { _chainVerify.value = ChainVerifyUiState.Done(it) }
                .onFailure { _chainVerify.value = ChainVerifyUiState.Error(it.message ?: "Chain verify failed") }
        }
    }

    // Catalog-dispatched notifications (operator's own inbox)
    private val _notifications = MutableStateFlow<List<com.tribetails.auntieos.data.admin.NotificationEntry>>(emptyList())
    val notifications: StateFlow<List<com.tribetails.auntieos.data.admin.NotificationEntry>> = _notifications.asStateFlow()

    fun loadNotifications() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null
            repository.getNotifications().onSuccess { entries ->
                _notifications.value = entries.sortedByDescending { it.createdAt }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load notifications"
            }
            _isLoading.value = false
        }
    }

    // Bulk mark-read result message (e.g. "Marked 3 read."), surfaced as a toast.
    private val _bulkReadMessage = MutableStateFlow<String?>(null)
    val bulkReadMessage: StateFlow<String?> = _bulkReadMessage.asStateFlow()
    fun clearBulkReadMessage() { _bulkReadMessage.value = null }

    private val _bulkReadInFlight = MutableStateFlow(false)
    val bulkReadInFlight: StateFlow<Boolean> = _bulkReadInFlight.asStateFlow()

    /**
     * Stage 2 tail: mark the given notification ids read via the
     * bulkMarkNotificationsRead callable, then reload so the read state reflects.
     * Fail-loud: a callable failure surfaces verbatim; the server-reported "marked"
     * count is surfaced honestly (it can be less than requested when ids are stale).
     */
    fun markNotificationsRead(ids: List<String>) {
        if (ids.isEmpty() || _bulkReadInFlight.value) return
        _bulkReadInFlight.value = true
        viewModelScope.launch {
            repository.bulkMarkNotificationsRead(ids)
                .onSuccess { marked ->
                    _bulkReadMessage.value = bulkReadSummary(requested = ids.size, marked = marked)
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't mark read: ${throwable.message}"
                }
            _bulkReadInFlight.value = false
        }
    }

    /**
     * Step 4 quick-action: toggle ONE notification's read state. Routes through
     * markNotificationRead / markNotificationUnread, then reloads so the row's
     * read accent reflects the server write. Fail-loud via [_bulkReadMessage].
     */
    fun toggleNotificationRead(id: String, currentlyUnread: Boolean) {
        if (id.isBlank()) return
        viewModelScope.launch {
            val call = if (currentlyUnread) repository.markNotificationRead(id)
                else repository.markNotificationUnread(id)
            call.onSuccess {
                _bulkReadMessage.value = if (currentlyUnread) "Marked read." else "Marked unread."
                loadNotifications()
            }.onFailure { throwable ->
                _bulkReadMessage.value = "Couldn't update: ${throwable.message}"
            }
        }
    }

    /**
     * Step 4 quick-action: archive ONE notification out of the active inbox via
     * archiveNotification, then reload so it drops off the list. Fail-loud.
     */
    fun archiveNotification(id: String) {
        if (id.isBlank()) return
        viewModelScope.launch {
            repository.archiveNotification(id)
                .onSuccess { archived ->
                    _bulkReadMessage.value =
                        if (archived > 0) "Dismissed." else "Nothing to dismiss (already archived or unavailable)."
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't dismiss: ${throwable.message}"
                }
        }
    }

    /**
     * Step 4 quick-action: archive MANY notifications at once via
     * bulkArchiveNotifications. Honest about partial archives (stale ids skipped
     * server-side). Reuses [_bulkReadInFlight] so the multi-select control disables
     * during the call.
     */
    fun archiveNotifications(ids: List<String>) {
        if (ids.isEmpty() || _bulkReadInFlight.value) return
        _bulkReadInFlight.value = true
        viewModelScope.launch {
            repository.bulkArchiveNotifications(ids)
                .onSuccess { archived ->
                    _bulkReadMessage.value = bulkArchiveSummary(requested = ids.size, archived = archived)
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't dismiss: ${throwable.message}"
                }
            _bulkReadInFlight.value = false
        }
    }

    /**
     * Step 4 quick-action (booking notifications only): apply a booking transition
     * (APPROVE/REJECT) to the linked visit via batchUpdateBookings, then reload the
     * inbox. Fail-loud: the per-id failure (or success) is surfaced verbatim.
     */
    fun quickBookingAction(targetId: String, action: String) {
        if (targetId.isBlank()) return
        viewModelScope.launch {
            repository.batchUpdateBookings(listOf(targetId), action)
                .onSuccess { result ->
                    _bulkReadMessage.value = when {
                        result.updated > 0 -> "Booking ${action.lowercase()}."
                        result.failed.isNotEmpty() -> "Couldn't ${action.lowercase()}: ${result.failed.first().error}"
                        else -> "No booking updated."
                    }
                    loadNotifications()
                }
                .onFailure { throwable ->
                    _bulkReadMessage.value = "Couldn't ${action.lowercase()}: ${throwable.message}"
                }
        }
    }

    fun loadInvoices() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            invoiceRepository.getInvoices().onSuccess { invoiceList ->
                _invoices.value = invoiceList.sortedByDescending { it.date }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load invoices"
            }

            _isLoading.value = false
        }
    }

    fun loadPayments() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            invoiceRepository.getPayments().onSuccess { paymentList ->
                _payments.value = paymentList.sortedByDescending { it.date }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load payments"
            }

            _isLoading.value = false
        }
    }

    fun loadVisitLogs() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            repository.getVisitLogs().onSuccess { logList ->
                _visitLogs.value = logList.sortedByDescending { it.submitted }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load visit logs"
            }

            _isLoading.value = false
        }
    }

    fun loadTrainingDocuments() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            repository.getTrainingDocuments().onSuccess { docList ->
                _trainingDocuments.value = docList.sortedByDescending { it.uploadedAt }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load training documents"
            }

            _isLoading.value = false
        }
    }

    fun loadKinCareSessions() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            kinCareRepository.getKinCareSessions().onSuccess { sessionList ->
                _kinCareSessions.value = sessionList.sortedByDescending { it.startTime }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load kin care sessions"
            }
            // §A.8: load time blocks from unified business_settings (best-effort;
            // absence/no-Firebase just means no block labels). Wrapped so a missing
            // FirebaseApp in tests can't crash.
            runCatching { repository.getBusinessSettings().onSuccess { _timeBlocks.value = it.timeBlocks } }

            _isLoading.value = false
        }
    }

    fun loadKinCareReports() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            kinCareRepository.getAllKinCareReports().onSuccess { reportList ->
                _kinCareReports.value = reportList.sortedByDescending { sortKey(it) }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load KinTales"
            }

            _isLoading.value = false
        }
    }

    private fun sortKey(r: KinCareReport): String = sequenceOf(
        r.sentAt, r.updatedAt, r.visitDate, r.createdAt,
    ).firstOrNull { !it.isNullOrBlank() } ?: ""

    fun loadActivityLog() {
        viewModelScope.launch {
            _isLoading.value = true
            _error.value = null

            repository.getActivityLog().onSuccess { entries ->
                _activityLog.value = entries.sortedByDescending { it.timestamp }
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to load activity log"
            }

            _isLoading.value = false
        }
    }

    /**
     * Patches a Kin Care session and refreshes the local list so the row UI
     * reflects the new state immediately. Used by Auntie Time row buttons.
     */
    fun patchKinCareSession(id: String, patch: Map<String, Any>, onResult: (Throwable?) -> Unit = {}) {
        viewModelScope.launch {
            kinCareRepository.patchKinCareSession(id, patch).onSuccess {
                loadKinCareSessions()
                onResult(null)
            }.onFailure { t ->
                _error.value = t.message ?: "Failed to update Kin Care"
                onResult(t)
            }
        }
    }

    // Create new records
    fun createInvoice(invoice: Invoice) {
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.createInvoice(invoice).onSuccess {
                loadInvoices() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create invoice"
                _isLoading.value = false
            }
        }
    }

    /**
     * Step 4 (PART B): create a QUOTE (invoice in QUOTE status) via the createQuote
     * callable, optionally dispatching the issued-quote notification to the kinfolk.
     * Fail-loud: server validation surfaces verbatim through [_error]; success
     * confirms via [_invoiceActionMessage] and refreshes the list.
     */
    fun createQuote(invoice: Invoice, sendToKinfolk: Boolean) {
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.createQuote(invoice, sendToKinfolk).onSuccess {
                _invoiceActionMessage.value = if (sendToKinfolk) "Quote created and sent." else "Quote created."
                loadInvoices() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create quote"
                _isLoading.value = false
            }
        }
    }

    /** Slice 2: issue a receipt for an invoice via the generateReceipt callable. */
    fun generateReceipt(invoiceId: String) {
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.generateReceipt(invoiceId).onSuccess {
                loadInvoices() // Refresh to reflect receiptIssuedAt
                _invoiceActionMessage.value = "Receipt generated."
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to generate receipt"
                _isLoading.value = false
            }
        }
    }

    // Stage 2 tail: transient confirmation for the per-row invoice actions
    // (reminder / review-and-send). Errors still go to [_error]; this carries the
    // success line so the row action confirms loudly instead of silently. Cleared
    // by [clearInvoiceActionMessage].
    private val _invoiceActionMessage = MutableStateFlow<String?>(null)
    val invoiceActionMessage: StateFlow<String?> = _invoiceActionMessage.asStateFlow()

    fun clearInvoiceActionMessage() { _invoiceActionMessage.value = null }

    /**
     * Stage 2 tail: send an on-demand payment reminder for an invoice via the
     * sendInvoiceReminder callable. Fail-loud: server preconditions (already-paid,
     * not-found) surface verbatim through [_error].
     */
    fun sendInvoiceReminder(invoiceId: String) {
        if (invoiceId.isBlank()) return
        viewModelScope.launch {
            invoiceRepository.sendInvoiceReminder(invoiceId).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope = viewModelScope,
                    repository = repository,
                    actionType = "SEND_INVOICE_REMINDER",
                    description = "Sent payment reminder for invoice $invoiceId",
                    targetId = invoiceId,
                    targetCollection = "invoices",
                )
                _invoiceActionMessage.value = "Reminder sent."
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to send reminder"
            }
        }
    }

    /**
     * Stage 2 tail: transition a DRAFT invoice to "sent" via the postInvoiceEvent
     * callable (reviewAndSendDraftInvoice). Refreshes the list on success so the
     * draft affordance drops. Fail-loud: a blank kinfolk is rejected up front.
     */
    fun reviewAndSendDraftInvoice(invoice: Invoice) {
        if (invoice.id.isBlank()) return
        if (invoice.kinfolkId.isBlank()) {
            _error.value = "This invoice has no client (kinfolk) on record, so it cannot be sent."
            return
        }
        viewModelScope.launch {
            invoiceRepository.reviewAndSendDraftInvoice(invoice.id, invoice.kinfolkId).onSuccess {
                com.tribetails.auntieos.data.admin.AuditLog.fire(
                    scope = viewModelScope,
                    repository = repository,
                    actionType = "SEND_DRAFT_INVOICE",
                    description = "Reviewed and sent draft invoice ${invoice.invoiceNumber.ifBlank { invoice.id }}",
                    targetId = invoice.id,
                    targetCollection = "invoices",
                )
                loadInvoices()
                _invoiceActionMessage.value = "Draft sent."
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to send draft"
            }
        }
    }

    fun createPayment(payment: Payment) {
        viewModelScope.launch {
            _isLoading.value = true
            invoiceRepository.createPayment(payment).onSuccess {
                loadPayments() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create payment"
                _isLoading.value = false
            }
        }
    }

    fun createVisitLog(visitLog: VisitLog) {
        viewModelScope.launch {
            _isLoading.value = true
            repository.createVisitLog(visitLog).onSuccess {
                loadVisitLogs() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create visit log"
                _isLoading.value = false
            }
        }
    }

    // ─── Tribal Intel write tool (spec 23) ──────────────────────────────────
    // Pets for the currently selected kinfolk in the target picker.
    private val _kinForSelectedKinfolk = MutableStateFlow<List<com.tribetails.auntieos.data.model.Kin>>(emptyList())
    val kinForSelectedKinfolk: StateFlow<List<com.tribetails.auntieos.data.model.Kin>> = _kinForSelectedKinfolk.asStateFlow()

    // Honest "queued for reconcile" confirmation. The dossier/411 fold happens on
    // the next reconcile pass, never instantly, so the UI says exactly that.
    private val _trainingDocQueuedMessage = MutableStateFlow<String?>(null)
    val trainingDocQueuedMessage: StateFlow<String?> = _trainingDocQueuedMessage.asStateFlow()

    private val _trainingDocSaving = MutableStateFlow(false)
    val trainingDocSaving: StateFlow<Boolean> = _trainingDocSaving.asStateFlow()

    fun clearTrainingDocQueuedMessage() { _trainingDocQueuedMessage.value = null }

    fun loadKinForSelectedKinfolk(kinfolkId: String) {
        if (kinfolkId.isBlank()) { _kinForSelectedKinfolk.value = emptyList(); return }
        viewModelScope.launch {
            repository.getKin(kinfolkId).onSuccess { _kinForSelectedKinfolk.value = it }
                .onFailure { _error.value = it.message ?: "Failed to load pets" }
        }
    }

    // Draft attachments accumulated by the form before save. Uploaded to Cloudinary
    // first via MediaUploadManager (entityType TRIBAL_INTEL); only the resulting
    // storageUrl + publicId are passed into the create/update callable.
    private val _trainingDocAttachments = MutableStateFlow<List<TrainingDocAttachment>>(emptyList())
    val trainingDocAttachments: StateFlow<List<TrainingDocAttachment>> = _trainingDocAttachments.asStateFlow()

    private val _trainingDocUploading = MutableStateFlow(false)
    val trainingDocUploading: StateFlow<Boolean> = _trainingDocUploading.asStateFlow()

    fun setTrainingDocAttachments(list: List<TrainingDocAttachment>) { _trainingDocAttachments.value = list }
    fun removeTrainingDocAttachment(publicId: String) {
        _trainingDocAttachments.value = _trainingDocAttachments.value.filterNot { it.cloudinaryPublicId == publicId }
    }
    fun resetTrainingDocDraft() {
        _trainingDocAttachments.value = emptyList()
        _kinForSelectedKinfolk.value = emptyList()
        _trainingDocQueuedMessage.value = null
    }

    fun uploadTribalIntelAttachment(context: android.content.Context, uri: android.net.Uri) {
        viewModelScope.launch {
            _trainingDocUploading.value = true
            _error.value = null
            com.tribetails.auntieos.media.MediaUploadManager(context, repository).uploadMedia(
                uri = uri,
                entityId = "pending",
                entityType = MediaEntityType.TRIBAL_INTEL,
            ).onSuccess { media ->
                val att = TrainingDocAttachment(
                    storageUrl = media.storageUrl,
                    cloudinaryPublicId = media.cloudinaryPublicId,
                    fileType = media.fileType.name,
                    mimeType = media.mimeType,
                    fileName = media.originalFileName.ifBlank { media.fileName },
                )
                _trainingDocAttachments.value = _trainingDocAttachments.value + att
                _trainingDocUploading.value = false
            }.onFailure { e ->
                _error.value = "Attachment upload failed: ${e.message}"
                _trainingDocUploading.value = false
            }
        }
    }

    fun createTrainingDocument(
        title: String,
        content: String,
        notes: String,
        targetType: String,
        targetKinfolkId: String,
        targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
        onResult: (Throwable?) -> Unit = {},
    ) {
        viewModelScope.launch {
            _trainingDocSaving.value = true
            _error.value = null
            _trainingDocQueuedMessage.value = null
            repository.createTrainingDocument(title, content, notes, targetType, targetKinfolkId, targetKinId, attachments).onSuccess {
                _trainingDocSaving.value = false
                _trainingDocQueuedMessage.value =
                    "Queued for reconcile. The dossier and 411 update on the next reconcile pass, not instantly."
                loadTrainingDocuments()
                onResult(null)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create Tribal Intel"
                _trainingDocSaving.value = false
                onResult(throwable)
            }
        }
    }

    fun updateTrainingDocument(
        docId: String,
        title: String,
        content: String,
        notes: String,
        targetType: String,
        targetKinfolkId: String,
        targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
        onResult: (Throwable?) -> Unit = {},
    ) {
        viewModelScope.launch {
            _trainingDocSaving.value = true
            _error.value = null
            _trainingDocQueuedMessage.value = null
            repository.updateTrainingDocument(docId, title, content, notes, targetType, targetKinfolkId, targetKinId, attachments).onSuccess {
                _trainingDocSaving.value = false
                _trainingDocQueuedMessage.value =
                    "Queued for reconcile. The dossier and 411 update on the next reconcile pass, not instantly."
                loadTrainingDocuments()
                onResult(null)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to update Tribal Intel"
                _trainingDocSaving.value = false
                onResult(throwable)
            }
        }
    }

    fun deleteTrainingDocument(docId: String, onResult: (Throwable?) -> Unit = {}) {
        viewModelScope.launch {
            _trainingDocSaving.value = true
            _error.value = null
            repository.deleteTrainingDocument(docId).onSuccess {
                _trainingDocSaving.value = false
                loadTrainingDocuments()
                onResult(null)
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to delete Tribal Intel"
                _trainingDocSaving.value = false
                onResult(throwable)
            }
        }
    }

    fun createKinCareSession(session: KinCareSession) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.createKinCareSession(session).onSuccess {
                loadKinCareSessions() // Refresh the list
            }.onFailure { throwable ->
                _error.value = throwable.message ?: "Failed to create session"
                _isLoading.value = false
            }
        }
    }

    fun clearError() {
        _error.value = null
    }

    // ─── Orphan KinCareReport triage ──────────────────────────────────────────
    //
    // Three actions an admin can take on a post-migration orphan:
    //   • assignOrphanReport     - link to a real kinfolk
    //   • markOrphanAsDuplicate  - point at the canonical report ID
    //   • archiveOrphanAsBad     - soft-archive with a required reason
    //
    // Each flow refreshes the report list on success so the row disappears
    // from "Needs Triage" immediately, and publishes a TriageResult so the
    // screen can render a success or error toast (fail-loud: any repo
    // failure surfaces here, never swallowed).

    fun loadKinfolkDirectory() {
        viewModelScope.launch {
            repository.getKinfolk().onSuccess { list ->
                _kinfolkDirectory.value = list.sortedBy { "${it.firstName} ${it.lastName}".trim().lowercase() }
            }.onFailure { t ->
                _error.value = t.message ?: "Failed to load kinfolk directory"
            }
        }
    }

    fun assignOrphanReport(reportId: String, kinfolkId: String, kinfolkName: String) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.assignKinfolkToOrphanReport(reportId, kinfolkId, kinfolkName)
                .onSuccess {
                    _triageResult.value = TriageResult(true, "Assigned to $kinfolkName")
                    loadKinCareReports()
                }
                .onFailure { t ->
                    _triageResult.value = TriageResult(false, t.message ?: "Failed to assign kinfolk")
                    _isLoading.value = false
                }
        }
    }

    fun markOrphanAsDuplicate(reportId: String, duplicateOfReportId: String) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.markOrphanReportAsDuplicate(reportId, duplicateOfReportId)
                .onSuccess {
                    _triageResult.value = TriageResult(true, "Marked as duplicate")
                    loadKinCareReports()
                }
                .onFailure { t ->
                    _triageResult.value = TriageResult(false, t.message ?: "Failed to mark duplicate")
                    _isLoading.value = false
                }
        }
    }

    fun archiveOrphanAsBad(reportId: String, reason: String) {
        viewModelScope.launch {
            _isLoading.value = true
            kinCareRepository.archiveOrphanReportAsBadData(reportId, reason)
                .onSuccess {
                    _triageResult.value = TriageResult(true, "Archived as bad data")
                    loadKinCareReports()
                }
                .onFailure { t ->
                    _triageResult.value = TriageResult(false, t.message ?: "Failed to archive report")
                    _isLoading.value = false
                }
        }
    }

    fun clearTriageResult() {
        _triageResult.value = null
    }
}

/**
 * Honest summary for a bulk mark-read action. The server may mark fewer than
 * requested when some ids are stale (already gone or owned by someone else), so we
 * say so rather than implying every selection succeeded. Pure; unit-tested.
 */
internal fun bulkReadSummary(requested: Int, marked: Int): String = when {
    requested <= 0 -> "Nothing selected."
    marked == requested -> "Marked $marked read."
    marked == 0 -> "Marked 0 of $requested read (already read or no longer available)."
    else -> "Marked $marked of $requested read."
}

/**
 * Honest summary for a bulk archive action. Like [bulkReadSummary], the server may
 * archive fewer than requested when some ids are stale, so we say so rather than
 * implying every selection was dismissed. Pure; unit-tested.
 */
internal fun bulkArchiveSummary(requested: Int, archived: Int): String = when {
    requested <= 0 -> "Nothing selected."
    archived == requested -> "Dismissed $archived."
    archived == 0 -> "Dismissed 0 of $requested (already archived or no longer available)."
    else -> "Dismissed $archived of $requested."
}

/**
 * A notification is "unread" while it has no readAt marker. The dispatch status
 * (pending/dispatched) is orthogonal: a dispatched notification can still be unread.
 * Pure; unit-tested.
 */
internal fun isNotificationUnread(entry: com.tribetails.auntieos.data.admin.NotificationEntry): Boolean =
    entry.readAt.isNullOrBlank()
