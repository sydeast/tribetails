package com.tribetails.auntieos.ui.kintales

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class KinTaleUiState(
    val isLoading: Boolean = true,
    val session: KinCareSession? = null,
    val kinList: List<Kin> = emptyList(),
    val kinfolk: Kinfolk? = null,
    val template: KinTaleTemplate = DefaultKinTaleTemplate.template,
    val report: KinCareReport = KinCareReport(),
    val uploadedMedia: List<MediaFile> = emptyList(),
    val gpsRoute: List<GpsPoint> = emptyList(),
    val isUploading: Boolean = false,
    val isSaving: Boolean = false,
    val isSending: Boolean = false,
    val isGenerating: Boolean = false,
    // Opener of the last generated draft; fed back as avoid_opening on regenerate.
    val lastOpening: String? = null,
    val saveStatus: SaveStatus = SaveStatus.IDLE,
    val error: String? = null,
    val sentSuccessfully: Boolean = false,
    // Phase 14: admin-authored KINTALE form_schemas (appliesTo == KINTALE), DISTINCT
    // from the template-driven fieldResponses. Answers live on report.formValues.
    val kinTaleSchemas: List<FormSchema> = emptyList(),
    val schemaError: String? = null,
    // ── KinTale comment thread (SENT report, spec 11 item 6.2) ──
    val comments: KinTaleCommentsRepository.CommentsState = KinTaleCommentsRepository.CommentsState.Loading,
    val commentDraft: String = "",
    val replyTargetId: String? = null,
    val isPostingComment: Boolean = false,
    val commentError: String? = null,
    // ── View-as-kinfolk preview + share link (spec: kintale.viewAsKinfolk) ──
    // viewAsKinfolk toggles the read-only kinfolk-facing preview of this report.
    // shareUrl holds the minted createShareLink URL once requested; isSharing /
    // shareError drive the loading + fail-loud states for that action.
    val viewAsKinfolk: Boolean = false,
    val isSharing: Boolean = false,
    val shareUrl: String? = null,
    val shareError: String? = null,
)

enum class SaveStatus { IDLE, SAVED, ERROR }

class KinTaleReportViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    private val mediaUploader: MediaUploadManager = AuntieOSApp.instance.mediaUploadManager,
    private val notifier: VisitNotifier = AuntieOSApp.instance.visitNotifier,
    private val commentsRepo: KinTaleCommentsRepository = KinTaleCommentsRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(KinTaleUiState())
    val uiState: StateFlow<KinTaleUiState> = _uiState.asStateFlow()

    /** Tracks the active comment-stream collection so a re-load doesn't double-subscribe. */
    private var commentsJob: Job? = null
    private var commentsTaleId: String? = null

    fun load(sessionId: String, existingReportId: String?) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            val session = repository.getKinCareSession(sessionId).getOrNull()

            if (session == null) {
                _uiState.value = _uiState.value.copy(isLoading = false, error = "Session not found")
                return@launch
            }

            val kinfolk = if (session.kinfolkId.isNotBlank()) {
                repository.getKinfolkById(session.kinfolkId).getOrNull()
            } else null

            // Filter to the kin actually in this session if kinIds is populated;
            // fall back to all of the kinfolk's active kin (legacy sessions).
            val kinList = if (session.kinfolkId.isNotBlank()) {
                val all = repository.getKin(session.kinfolkId).getOrDefault(emptyList())
                if (session.kinIds.isNotEmpty()) all.filter { it.id in session.kinIds } else all
            } else emptyList()

            // Resolve the template - service-specific match in Firestore, falling back to the built-in default
            val template = repository.getActiveTemplateForService(session.serviceType).getOrNull()
                ?: DefaultKinTaleTemplate.template

            // Resume an existing draft if a reportId was passed; otherwise scaffold IN-MEMORY only.
            // Draft is NOT persisted to Firestore until the first content change (Auntie's Q3).
            val report = if (existingReportId != null) {
                repository.getKinCareReport(existingReportId).getOrNull() ?: scaffoldReport(session, template)
            } else {
                scaffoldReport(session, template)
            }

            // Hydrate uploaded media (only meaningful for resumed drafts)
            val media = if (report.id.isNotBlank() && report.mediaFileIds.isNotEmpty()) {
                repository.getMediaFiles(sessionId, MediaEntityType.VISIT_LOG)
                    .getOrDefault(emptyList())
                    .filter { it.id in report.mediaFileIds }
            } else emptyList()

            // Phase 14: load KINTALE-placed form_schemas. Fail-loud via schemaError.
            val schemas = runCatching {
                val summaries = repository.listFormSchemas().getOrThrow()
                appliesToSchemaIds(summaries, "KINTALE").mapNotNull { repository.getFormSchema(it).getOrThrow() }
            }

            _uiState.value = _uiState.value.copy(
                isLoading = false,
                session = session,
                kinfolk = kinfolk,
                kinList = kinList,
                template = template,
                report = report,
                uploadedMedia = media,
                gpsRoute = session.gpsSummary?.route.orEmpty(),
                kinTaleSchemas = schemas.getOrDefault(emptyList()),
                schemaError = schemas.exceptionOrNull()?.let { it.message ?: "Couldn't load custom fields" },
            )
        }
    }

    /** Phase 14: update one KINTALE custom-field answer (in-memory; persisted on save/send). */
    fun updateFormValue(key: String, value: String) {
        val current = _uiState.value.report
        _uiState.value = _uiState.value.copy(report = current.copy(formValues = current.formValues + (key to value)))
    }

    private fun scaffoldReport(session: KinCareSession, template: KinTaleTemplate): KinCareReport =
        KinCareReport(
            sessionId = session.id,
            kinfolkId = session.kinfolkId,
            kinfolkName = session.kinfolkName,
            kinIds = session.kinIds,
            serviceType = session.serviceType,
            visitDate = session.startTime,
            arrivedAt = session.arrivedAt,
            departedAt = session.departedAt,
            visitRouteId = session.visitRouteId,
            templateId = template.id.takeUnless { it == DefaultKinTaleTemplate.template.id } ?: "",
            status = ReportStatus.DRAFT.name
        )

    // --- Field updates (in-memory; persisted via persistDraft on blur / section change) ---

    fun updateBodyCopy(text: String) {
        _uiState.value = _uiState.value.copy(
            report = _uiState.value.report.copy(bodyCopy = text)
        )
    }

    /**
     * Generate-draft: turn the shorthand in report.bodyCopy into a full KinTale via
     * the same generate path as Communicate (Firebase function, gated by the flag).
     * The result drops into the editable body; manual editing still works. Regenerate
     * passes the previous opener as avoid_opening so a re-roll genuinely varies (the
     * "I don't like v1" path). Fail-loud via state.error.
     */
    fun generateDraft(useFunction: Boolean = true) {
        val state = _uiState.value
        if (state.isGenerating) return
        val notes = state.report.bodyCopy.trim()
        if (notes.isEmpty()) {
            _uiState.value = state.copy(error = "Jot a few notes first so Auntie has something to work with.")
            return
        }
        val recipient = state.kinfolk?.displayName.orEmpty()
        if (recipient.isBlank()) {
            _uiState.value = state.copy(error = "This Kin Care has no linked Kinfolk to write to.")
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isGenerating = true, error = null)
            repository.generate(
                GenerateRequest(
                    communication_type = "visit_report",
                    recipient = recipient,
                    raw_notes = notes,
                    tone_hint = "",
                    max_length = "",
                    avoid_opening = state.lastOpening,
                ),
                useFunction = useFunction,
            ).onSuccess { result ->
                val copy = result.generatedCopy
                val opener = copy.trim().takeWhile { !it.isWhitespace() }.ifBlank { null }
                _uiState.value = _uiState.value.copy(
                    isGenerating = false,
                    report = _uiState.value.report.copy(bodyCopy = copy),
                    lastOpening = opener,
                )
                persistDraft()
            }.onFailure { e ->
                AuntieLog.e("KinTale generate-draft failed", e)
                _uiState.value = _uiState.value.copy(
                    isGenerating = false,
                    error = "Generate failed: ${e.message ?: "unknown error"}",
                )
            }
        }
    }

    /** Update the cover headline in-memory; persisted via persistDraft on blur. */
    fun updateTitle(text: String) {
        _uiState.value = _uiState.value.copy(
            report = _uiState.value.report.copy(title = text)
        )
    }

    fun setBoolField(fieldKey: String, kinId: String, value: Boolean) {
        mutateField(fieldKey, kinId) { it.copy(boolValue = value) }
        persistDraft() // toggle = section change
    }

    fun setIntField(fieldKey: String, kinId: String, value: Int) {
        mutateField(fieldKey, kinId) { it.copy(intValue = value) }
        persistDraft()
    }

    fun setStringField(fieldKey: String, kinId: String, value: String) {
        mutateField(fieldKey, kinId) { it.copy(stringValue = value) }
        // string changes save on blur, not every keystroke
    }

    /** Set a checklist item response (true/false) for a given scope. kinId blank for PER_VISIT. */
    fun setChecklistResponse(itemKey: String, kinId: String, checked: Boolean) {
        mutateField(itemKey, kinId) { it.copy(boolValue = checked) }
        persistDraft()
    }

    /** Set the mood selection for a given kin. */
    fun setMoodForKin(kinId: String, moodKey: String) {
        val current = _uiState.value.report
        val updated = current.petMoodSelections.toMutableMap().apply { put(kinId, moodKey) }
        _uiState.value = _uiState.value.copy(report = current.copy(petMoodSelections = updated))
        persistDraft()
    }

    private fun mutateField(fieldKey: String, kinId: String, transform: (FieldResponse) -> FieldResponse) {
        val current = _uiState.value.report
        val key = responseKey(fieldKey, kinId)
        val existing = current.fieldResponses[key] ?: FieldResponse(fieldKey = fieldKey, kinId = kinId)
        val updated = current.fieldResponses.toMutableMap().apply {
            put(key, transform(existing))
        }
        _uiState.value = _uiState.value.copy(report = current.copy(fieldResponses = updated))
    }

    fun responseFor(fieldKey: String, kinId: String): FieldResponse =
        _uiState.value.report.fieldResponses[responseKey(fieldKey, kinId)]
            ?: FieldResponse(fieldKey = fieldKey, kinId = kinId)

    private fun responseKey(fieldKey: String, kinId: String): String =
        if (kinId.isBlank()) fieldKey else "$kinId|$fieldKey"

    /** Persist the draft. Creates the Firestore record on first call when content exists. */
    fun persistDraft() {
        val state = _uiState.value
        val report = state.report
        if (!hasContent(report)) return // nothing to save yet - keep the ghost out of Firestore

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true)
            try {
                if (report.id.isBlank()) {
                    val newId = repository.createKinCareReport(report).getOrNull()
                    if (newId != null) {
                        _uiState.value = _uiState.value.copy(
                            report = _uiState.value.report.copy(id = newId),
                            isSaving = false,
                            saveStatus = SaveStatus.SAVED
                        )
                    } else {
                        _uiState.value = _uiState.value.copy(isSaving = false, saveStatus = SaveStatus.ERROR)
                    }
                } else {
                    repository.updateKinCareReport(_uiState.value.report).fold(
                        onSuccess = {
                            _uiState.value = _uiState.value.copy(isSaving = false, saveStatus = SaveStatus.SAVED)
                        },
                        onFailure = { e ->
                            AuntieLog.e("KinTale autosave failed", e)
                            _uiState.value = _uiState.value.copy(
                                isSaving = false,
                                saveStatus = SaveStatus.ERROR,
                                error = "Couldn't save: ${e.message}"
                            )
                        }
                    )
                }
            } catch (e: Exception) {
                AuntieLog.e("KinTale persistDraft crashed", e)
                _uiState.value = _uiState.value.copy(isSaving = false, saveStatus = SaveStatus.ERROR)
            }
        }
    }

    private fun hasContent(report: KinCareReport): Boolean =
        report.title.isNotBlank() ||
            report.bodyCopy.isNotBlank() ||
            report.fieldResponses.isNotEmpty() ||
            report.mediaFileIds.isNotEmpty() ||
            report.petMoodSelections.isNotEmpty() ||
            // Phase 14: an answered KINTALE custom field counts as content.
            report.formValues.values.any { it.isNotBlank() }

    fun addMedia(context: Context, uri: Uri) {
        val sessionId = _uiState.value.session?.id ?: return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isUploading = true)
            mediaUploader.uploadMedia(
                uri = uri,
                entityId = sessionId,
                entityType = MediaEntityType.VISIT_LOG,
                description = "KinTale media",
                tags = listOf("kintale")
            ).fold(
                onSuccess = { media ->
                    val newIds = _uiState.value.report.mediaFileIds + media.id
                    val updated = _uiState.value.report.copy(mediaFileIds = newIds)
                    _uiState.value = _uiState.value.copy(
                        isUploading = false,
                        uploadedMedia = _uiState.value.uploadedMedia + media,
                        report = updated
                    )
                    persistDraft() // media is one of the protected fields
                },
                onFailure = { e ->
                    AuntieLog.e("KinTale media upload failed", e)
                    _uiState.value = _uiState.value.copy(
                        isUploading = false,
                        error = "Upload failed: ${e.message}"
                    )
                }
            )
        }
    }

    fun removeMedia(mediaId: String) {
        val report = _uiState.value.report
        val updated = report.copy(mediaFileIds = report.mediaFileIds.filter { it != mediaId })
        _uiState.value = _uiState.value.copy(
            report = updated,
            uploadedMedia = _uiState.value.uploadedMedia.filter { it.id != mediaId }
        )
        persistDraft()
    }

    fun send() {
        val state = _uiState.value
        val report = state.report
        val session = state.session ?: return
        val kinfolk = state.kinfolk ?: run {
            _uiState.value = _uiState.value.copy(error = "Cannot send: recipient contact not found.")
            return
        }

        if (!hasContent(report)) {
            _uiState.value = _uiState.value.copy(error = "Nothing to send yet - fill in some details.")
            return
        }

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSending = true)
            // Make sure latest state is persisted (and create on first call if needed)
            if (report.id.isBlank()) {
                val newId = repository.createKinCareReport(report).getOrNull()
                if (newId != null) {
                    _uiState.value = _uiState.value.copy(report = _uiState.value.report.copy(id = newId))
                }
            } else {
                repository.updateKinCareReport(report).getOrNull()
            }
            val savedReport = _uiState.value.report
            if (savedReport.id.isBlank()) {
                _uiState.value = _uiState.value.copy(isSending = false, error = "Couldn't save before sending.")
                return@launch
            }

            notifier.notify(
                event = VisitNotifier.Event.REPORT_SENT,
                session = session,
            ).fold(
                onSuccess = { result ->
                    val firstDispatchId = result.dispatchIds.firstOrNull().orEmpty()
                    repository.markReportSent(
                        reportId = savedReport.id,
                        sessionId = session.id,
                        sentVia = "catalog",
                        deliveryReceiptId = firstDispatchId,
                    )
                    _uiState.value = _uiState.value.copy(
                        isSending = false,
                        sentSuccessfully = true,
                        report = savedReport.copy(
                            status = ReportStatus.SENT.name,
                            sentVia = "catalog",
                        )
                    )
                },
                onFailure = { e ->
                    AuntieLog.e("KinTale send failed", e)
                    _uiState.value = _uiState.value.copy(
                        isSending = false,
                        error = "Couldn't send: ${e.message}"
                    )
                }
            )
        }
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }

    // ── View-as-kinfolk preview + share link ─────────────────────────────────

    /** Toggle the read-only kinfolk-facing preview of this report. */
    fun toggleViewAsKinfolk() {
        _uiState.value = _uiState.value.copy(viewAsKinfolk = !_uiState.value.viewAsKinfolk)
    }

    /** Dismiss a surfaced share-link error banner. */
    fun clearShareError() {
        _uiState.value = _uiState.value.copy(shareError = null)
    }

    /**
     * Mint a kinfolk-facing share link for the current report via the deployed
     * createShareLink callable and stash the resulting URL for display/copy.
     *
     * Fail-loud: an unsaved report (blank id), a missing recipient kinfolkId, or a
     * callable failure sets shareError (banner) and never fabricates a URL. A
     * successful call replaces any prior URL/error.
     */
    fun requestShareLink() {
        val report = _uiState.value.report
        if (report.id.isBlank()) {
            _uiState.value = _uiState.value.copy(shareError = "Save the report before sharing.")
            return
        }
        if (report.kinfolkId.isBlank()) {
            _uiState.value = _uiState.value.copy(shareError = "Could not share: recipient kinfolk is missing.")
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSharing = true, shareError = null)
            repository.createShareLink(reportId = report.id, familyId = report.kinfolkId).fold(
                onSuccess = { result ->
                    _uiState.value = _uiState.value.copy(
                        isSharing = false,
                        shareUrl = result.shareUrl,
                        shareError = null,
                    )
                },
                onFailure = { e ->
                    AuntieLog.e("KinTale share-link create failed", e)
                    _uiState.value = _uiState.value.copy(
                        isSharing = false,
                        shareError = "Could not create share link: ${e.message}",
                    )
                },
            )
        }
    }

    // ── KinTale comment thread (SENT report, spec 11 item 6.2) ───────────────────

    /**
     * Subscribe to the live comment thread for [taleId]. Idempotent per id, so the
     * screen can call it for the resolved report id without re-subscribing on each
     * recomposition. Fail-loud: the repo emits CommentsState.Error on a listener
     * failure, which the screen banners (no silent emptyList).
     */
    fun observeComments(taleId: String) {
        if (taleId.isBlank() || commentsTaleId == taleId) return
        commentsTaleId = taleId
        commentsJob?.cancel()
        commentsJob = viewModelScope.launch {
            commentsRepo.streamComments(taleId).collect { state ->
                _uiState.value = _uiState.value.copy(comments = state)
            }
        }
    }

    fun updateCommentDraft(text: String) {
        _uiState.value = _uiState.value.copy(
            commentDraft = text,
            commentError = if (_uiState.value.commentError != null) null else _uiState.value.commentError,
        )
    }

    /** Set (or clear) the reply target. Passing null returns to top-level compose. */
    fun setReplyTarget(commentId: String?) {
        _uiState.value = _uiState.value.copy(replyTargetId = commentId)
    }

    /**
     * Post the current draft as an admin comment (top-level or a reply to the active
     * replyTargetId). Fail-loud: a blank body sets commentError and writes nothing; a
     * callable failure surfaces "Could not post: ...". On success the draft + reply
     * target clear; the live stream renders the new row.
     */
    fun postComment(taleId: String, kinfolkId: String) {
        val body = _uiState.value.commentDraft.trim()
        if (body.isBlank()) {
            _uiState.value = _uiState.value.copy(commentError = "Write something first.")
            return
        }
        if (kinfolkId.isBlank()) {
            _uiState.value = _uiState.value.copy(commentError = "Could not post: recipient kinfolk is missing.")
            return
        }
        val parentId = _uiState.value.replyTargetId
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isPostingComment = true, commentError = null)
            commentsRepo.addComment(taleId, kinfolkId, body, parentId).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        isPostingComment = false,
                        commentDraft = "",
                        replyTargetId = null,
                        commentError = null,
                    )
                },
                onFailure = { e ->
                    _uiState.value = _uiState.value.copy(
                        isPostingComment = false,
                        commentError = "Could not post: ${e.message}",
                    )
                },
            )
        }
    }
}
