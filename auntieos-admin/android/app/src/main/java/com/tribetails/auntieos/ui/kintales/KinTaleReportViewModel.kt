package com.tribetails.auntieos.ui.kintales

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.KinTaleCommentsRepository
import com.tribetails.auntieos.media.PhotoLocationTagging
import com.tribetails.auntieos.media.MediaUploadManager
import com.tribetails.auntieos.notifications.VisitNotifier
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
    val reportLoadFailed: Boolean = false,
    // ── Autosave, as the sitter sees it ──
    // When the last write the SERVER ACCEPTED happened, epoch millis, null until
    // one has. "Draft saved" with no time on it reads the same whether the last
    // write was two seconds or two hours ago, and the sitter is being asked to
    // trust it with work they cannot see.
    val lastSavedAtMillis: Long? = null,
    // Whether the report currently differs from the copy the server holds.
    // Recomputed from the field diff rather than tracked by a flag, so it cannot
    // drift out of agreement with what a save would actually write.
    val hasUnsavedChanges: Boolean = false,
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
) {
    // ── Draft validation (#552), the same rules the React composer enforces ──
    //
    // DERIVED, never stored. A stored copy of "is the headline legal" is a second
    // answer that can disagree with the headline, and the field it describes
    // changes on every keystroke. Computing it off [report] means the screen and
    // the send guard cannot read different verdicts.
    //
    // `auntieos-admin/src/lib/kinTaleDraftSchema.ts` is the other half of this;
    // [kinTaleTitleError] / [kinTaleBodyError] carry the port note.

    /** The headline's problem, or null. Shown under the field, not on send. */
    val titleError: String? get() = kinTaleTitleError(report.title)

    /** The body's problem, or null. */
    val bodyError: String? get() = kinTaleBodyError(report.bodyCopy)

    /** The first field problem anywhere in the draft, or null when it is clean. */
    val validationError: String? get() = titleError ?: bodyError

    /**
     * Why this draft cannot be SENT (as opposed to saved), or null.
     *
     * A draft with a rule broken in it is still a draft, and saving it has to keep
     * working. Only the outward-facing action is gated.
     */
    val sendBlocker: String? get() = validationError ?: kinTaleSendBlocker(report.sessionId)
}

enum class SaveStatus { IDLE, SAVED, ERROR }

class KinTaleReportViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
    // W4-3: the visit being written up, the KinTale itself and its share link
    // are KinCare domain. [repository] still serves this screen's template,
    // media, form-schema and AI-generation reads.
    private val kinCareRepository: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
    private val mediaUploader: MediaUploadManager = AuntieOSApp.instance.mediaUploadManager,
    private val notifier: VisitNotifier = AuntieOSApp.instance.visitNotifier,
    private val commentsRepo: KinTaleCommentsRepository = KinTaleCommentsRepository(),
    /** Injected so the saved-at stamp is assertable rather than wall-clock luck. */
    private val now: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    companion object {
        /**
         * How long the sitter must stop typing before the draft saves itself.
         *
         * Three seconds is chosen against the two neighbours it has to sit
         * between. Shorter and an ordinary mid-sentence think-pause becomes a
         * write, on a screen whose users are outdoors on phone data. Longer and
         * the window of work a dropped session can lose stops feeling like
         * "the last thing I typed".
         *
         * It is a FLOOR on how often typing alone can write, not a period: the
         * timer is reset by every keystroke and cancelled by every blur, so a
         * sitter typing steadily for a minute produces one write at the end of
         * it, not twenty.
         */
        const val AUTOSAVE_DEBOUNCE_MS = 3_000L
    }

    private val _uiState = MutableStateFlow(KinTaleUiState())
    val uiState: StateFlow<KinTaleUiState> = _uiState.asStateFlow()

    /** Tracks the active comment-stream collection so a re-load doesn't double-subscribe. */
    private var commentsJob: Job? = null
    private var commentsTaleId: String? = null

    /**
     * The KinTale exactly as Firestore handed it over, and the only thing a save is
     * allowed to diff against.
     *
     * NULL UNTIL THE REPORT IS KNOWN TO EXIST ON THE SERVER, which is the whole of
     * the second fix. A new draft has no baseline because it has no document yet;
     * [persistDraft] creates one on first content. A RESUMED draft whose read
     * FAILED also has no baseline, and there [persistDraft] refuses - see
     * [reportExistsOnServer] for why those two cases must not be confused.
     *
     * It advances only after a write the server accepted, and only to the snapshot
     * that write actually carried, so a keystroke typed while a save was in flight
     * is not marked saved by it.
     */
    private var reportBaseline: KinCareReport? = null

    /**
     * Whether the report being edited is known to exist in Firestore.
     *
     * `null` = a genuinely new draft: nothing to read, nothing to lose, create on
     * first content. `false` = a resume whose read failed or found nothing: there
     * IS a document (or there was) and we do not have it, so nothing may be written
     * over it. `true` = resumed, baseline held.
     *
     * Two booleans would let "new" and "failed to read" collapse into one another,
     * which is precisely the bug: `getOrNull() ?: scaffoldReport(...)` made a failed
     * read indistinguishable from a fresh start, and the first keystroke then
     * persisted a blank scaffold over a half-written KinTale.
     */
    private var reportExistsOnServer: Boolean? = null

    /** The arguments of the last [load], so [retryLoad] can repeat it exactly. */
    private var loadedSessionId: String? = null
    private var loadedReportId: String? = null

    /**
     * The pending autosave, if the sitter is mid-burst. Exactly one may exist.
     *
     * THE AUTOSAVE IS A TIMER IN FRONT OF [persistDraft], NOT A SECOND WRITE PATH.
     * This screen already persisted on blur, on section change, on every toggle and
     * mood pick, on media add/remove, on Back and on Save Draft. Adding an
     * independent writer would have given one edit two ways to reach Firestore and
     * made them race; instead every trigger funnels through [persistDraft], and
     * [persistDraft] cancels whatever timer is outstanding. One edit, one write.
     */
    private var autosaveJob: Job? = null

    /**
     * Schedule a save for [AUTOSAVE_DEBOUNCE_MS] after the last keystroke.
     *
     * Called only by the TEXT paths. Toggles, mood picks and media already persist
     * immediately, and putting them on a delay would be a downgrade.
     */
    private fun scheduleAutosave() {
        // A KinTale we failed to read is not saveable at all, and a timer ticking
        // over its blank scaffold is the continuous version of that bug.
        if (reportExistsOnServer == false) return
        autosaveJob?.cancel()
        autosaveJob = viewModelScope.launch {
            delay(AUTOSAVE_DEBOUNCE_MS)
            // Cleared BEFORE the call, so persistDraft's own cancel cannot cancel
            // the coroutine it is currently running inside.
            autosaveJob = null
            persistDraft()
        }
    }

    /**
     * Recompute whether the draft differs from the copy the server holds.
     *
     * Derived from the same field diff a save would send rather than tracked by a
     * dirty flag, so the marker the sitter reads cannot drift from what is actually
     * pending: retyping a word to the value it already had leaves nothing unsaved,
     * and it says so.
     */
    private fun syncUnsavedMarker() {
        val state = _uiState.value
        val baseline = reportBaseline
        val dirty = when {
            reportExistsOnServer == false -> false // nothing here is savable anyway
            baseline == null -> hasContent(state.report) // a new draft with content, not yet created
            else -> kinCareReportFieldChanges(baseline, state.report).isNotEmpty()
        }
        if (dirty != state.hasUnsavedChanges) {
            _uiState.value = state.copy(hasUnsavedChanges = dirty)
        }
    }

    fun load(sessionId: String, existingReportId: String?) {
        loadedSessionId = sessionId
        loadedReportId = existingReportId
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                isLoading = true,
                error = null,
                reportLoadFailed = false,
            )

            val session = kinCareRepository.getKinCareSession(sessionId).getOrNull()

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
            //
            // A FAILED RESUME-READ IS NOT A NEW DRAFT, and conflating the two was the
            // worse of this screen's two data-loss bugs. This used to read
            // `getKinCareReport(id).getOrNull() ?: scaffoldReport(session, template)`,
            // so a transient read failure - offline on a driveway, a permission blip,
            // a timeout - fell through to a BLANK scaffold carrying the same session
            // prefill. The screen rendered an empty editor over a real report, and the
            // first content change persisted it. A sitter's half-written KinTale was
            // replaced by an empty one, silently, with nothing raised anywhere.
            //
            // A read that FAILED and a read that found NOTHING are both refusals: an
            // id was passed, so a document is expected, and we do not have it. Neither
            // is saveable, and the screen offers a retry instead of an editor.
            val report: KinCareReport
            if (existingReportId != null) {
                val read = kinCareRepository.getKinCareReport(existingReportId)
                val resumed = read.getOrNull()
                if (resumed == null) {
                    reportBaseline = null
                    reportExistsOnServer = false
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        session = session,
                        kinfolk = kinfolk,
                        kinList = kinList,
                        template = template,
                        reportLoadFailed = true,
                        error = read.exceptionOrNull()
                            ?.let { "Couldn't open this KinTale: ${it.message ?: "unknown error"}" }
                            ?: "Couldn't open this KinTale: it is no longer in the KinTale log.",
                    )
                    return@launch
                }
                report = resumed
                reportBaseline = resumed
                reportExistsOnServer = true
            } else {
                report = scaffoldReport(session, template)
                reportBaseline = null
                reportExistsOnServer = null
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
                reportLoadFailed = false,
            )
        }
    }

    /**
     * Re-run the last [load]. Offered by the screen behind the "Couldn't open this
     * KinTale" banner, because a refusal the operator cannot act on is just a
     * dead end - the read that failed was usually transient.
     */
    fun retryLoad() {
        val sessionId = loadedSessionId ?: return
        load(sessionId, loadedReportId)
    }

    /**
     * Phase 14: update one KINTALE custom-field answer.
     *
     * Now autosaved. This used to be in-memory until an explicit save or send,
     * which made a typed custom-field answer the one piece of written work on this
     * screen that a killed process lost outright. A deliberate behavior change.
     */
    fun updateFormValue(key: String, value: String) {
        val current = _uiState.value.report
        _uiState.value = _uiState.value.copy(report = current.copy(formValues = current.formValues + (key to value)))
        syncUnsavedMarker()
        scheduleAutosave()
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

    // --- Field updates ---
    //
    // Text edits schedule the autosave; the blur / section-change / toggle paths
    // below still persist immediately and cancel that timer. Which trigger wins is
    // simply whichever comes first, and neither writes twice.

    fun updateBodyCopy(text: String) {
        _uiState.value = _uiState.value.copy(
            report = _uiState.value.report.copy(bodyCopy = text)
        )
        syncUnsavedMarker()
        scheduleAutosave()
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
                    // The linked household is already resolved here, so send its
                    // id and let the server read that doc directly. Without it
                    // the server re-derives the household from the display name
                    // by a case-folded startsWith scan, and a second household
                    // with the same first name gets the wrong dossier read into
                    // a tale that goes out under this one's name.
                    kinfolk_id = state.kinfolk?.id?.ifBlank { null },
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

    /** Update the cover headline; autosaved on the typing pause, and on blur. */
    fun updateTitle(text: String) {
        _uiState.value = _uiState.value.copy(
            report = _uiState.value.report.copy(title = text)
        )
        syncUnsavedMarker()
        scheduleAutosave()
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
        // Free text: the typing pause, or the blur, whichever comes first. Never
        // every keystroke.
        scheduleAutosave()
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
        syncUnsavedMarker()
    }

    fun responseFor(fieldKey: String, kinId: String): FieldResponse =
        _uiState.value.report.fieldResponses[responseKey(fieldKey, kinId)]
            ?: FieldResponse(fieldKey = fieldKey, kinId = kinId)

    private fun responseKey(fieldKey: String, kinId: String): String =
        if (kinId.isBlank()) fieldKey else "$kinId|$fieldKey"

    /**
     * Persist the draft: create the Firestore record on the first content change,
     * and thereafter write only the fields that CHANGED since the copy the server
     * handed over.
     *
     * WHY A DIFF. `updateKinCareReport` used to take the whole [KinCareReport] under
     * `SetOptions.merge()`, which protects fields outside the written map and does
     * nothing about stale fields inside it - so every blur wrote all 30 modelled
     * fields back at the values this client last loaded. `kin_care_reports` has four
     * writers, three of them not this screen, so that reverted send state and orphan
     * triage decisions made while a draft sat open. `KinCareReportDiff.kt` holds the
     * field map and the reasoning; #312, #315, #327 and #332 are the same fix on
     * five sibling documents.
     *
     * REFUSED OUTRIGHT when the report was supposed to be read and was not
     * ([reportExistsOnServer] false). That is not a save that can be retried into
     * correctness - the local model is a blank scaffold, and writing it is the data
     * loss. The screen surfaces the banner and a retry instead.
     *
     * NOTHING CHANGED MEANS NOTHING IS WRITTEN, not even the stamp. Blur fires
     * whether or not the operator typed anything, so this is the common case, not
     * the corner one - and `updatedAt` is what the operator reads as "my work is
     * safe as of then".
     */
    fun persistDraft() {
        // Every trigger funnels through here, so an immediate persist retires the
        // pending timer rather than letting it write the same edit a second time.
        // The autosave coroutine clears this reference before calling in, so this
        // never cancels the coroutine it is running inside.
        autosaveJob?.cancel()
        autosaveJob = null

        val report = _uiState.value.report
        if (reportExistsOnServer == false) {
            // A blank scaffold standing in for a KinTale we failed to read. Writing
            // it is the loss; refusing is the fix.
            _uiState.value = _uiState.value.copy(
                saveStatus = SaveStatus.ERROR,
                error = "This KinTale never opened, so it can't be saved. Tap Retry to load it.",
            )
            return
        }
        if (!hasContent(report)) return // nothing to save yet - keep the ghost out of Firestore

        val baseline = reportBaseline
        if (baseline != null) {
            // The snapshot this write carries. The baseline advances to THIS, not to
            // whatever the report holds when the write returns, so a keystroke typed
            // while the save was in flight is not marked saved by it.
            val snapshot = report
            val changes = kinCareReportFieldChanges(baseline, snapshot)
            if (changes.isEmpty()) {
                // Nothing to send. The saved-at stamp does NOT move: it says when
                // the server last took something, and a no-op save took nothing.
                _uiState.value = _uiState.value.copy(saveStatus = SaveStatus.SAVED, hasUnsavedChanges = false)
                return
            }
            viewModelScope.launch {
                _uiState.value = _uiState.value.copy(isSaving = true)
                kinCareRepository.updateKinCareReportFields(snapshot.id, changes).fold(
                    onSuccess = {
                        reportBaseline = snapshot
                        _uiState.value = _uiState.value.copy(
                            isSaving = false,
                            saveStatus = SaveStatus.SAVED,
                            lastSavedAtMillis = now(),
                        )
                        // Against the ADVANCED baseline, so anything typed while
                        // this write was in flight is still correctly unsaved.
                        syncUnsavedMarker()
                    },
                    onFailure = { e ->
                        AuntieLog.e("KinTale draft save failed", e)
                        _uiState.value = _uiState.value.copy(
                            isSaving = false,
                            saveStatus = SaveStatus.ERROR,
                            error = "Couldn't save: ${e.message}",
                        )
                    },
                )
            }
            return
        }

        // No baseline and no failed read: a brand-new draft reaching Firestore for
        // the first time. The created report becomes the baseline, so the very next
        // save diffs against it instead of re-sending everything just written.
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true)
            val snapshot = _uiState.value.report
            kinCareRepository.createKinCareReport(snapshot).fold(
                onSuccess = { newId ->
                    reportBaseline = snapshot.copy(id = newId)
                    reportExistsOnServer = true
                    _uiState.value = _uiState.value.copy(
                        report = _uiState.value.report.copy(id = newId),
                        isSaving = false,
                        saveStatus = SaveStatus.SAVED,
                        lastSavedAtMillis = now(),
                    )
                    syncUnsavedMarker()
                },
                onFailure = { e ->
                    // No id was minted, so the retry must be another CREATE rather
                    // than a patch of a document that does not exist. Leaving the
                    // baseline null is what keeps that true.
                    AuntieLog.e("KinTale draft create failed", e)
                    _uiState.value = _uiState.value.copy(
                        isSaving = false,
                        saveStatus = SaveStatus.ERROR,
                        error = "Couldn't save: ${e.message}",
                    )
                },
            )
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
            // ISSUE #519: stamp where the visit was, but only if the operator
            // asked for it. Resolved BEFORE the upload so a slow settings or
            // breadcrumb read cannot leave a half-tagged record, and failing
            // soft: a photo that cannot be located is still worth uploading, so
            // an unreadable setting or an empty trail stamps nothing rather than
            // refusing the attachment.
            val photoLocation = runCatching {
                val settings = repository.getBusinessSettings().getOrNull() ?: return@runCatching null
                if (!settings.enableGPSTrackingForAllVisits || !settings.enablePhotoLocationTagging) {
                    return@runCatching null
                }
                val crumbs = kinCareRepository.getBreadcrumbs(sessionId).getOrNull().orEmpty()
                PhotoLocationTagging.locationFor(settings, PhotoLocationTagging.latestPing(crumbs))
            }.getOrNull()
            mediaUploader.uploadMedia(
                uri = uri,
                entityId = sessionId,
                entityType = MediaEntityType.VISIT_LOG,
                description = "KinTale media",
                tags = listOf("kintale"),
                location = photoLocation
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

        if (reportExistsOnServer == false) {
            _uiState.value = _uiState.value.copy(
                error = "This KinTale never opened, so it can't be sent. Tap Retry to load it.",
            )
            return
        }

        if (!hasContent(report)) {
            _uiState.value = _uiState.value.copy(error = "Nothing to send yet - fill in some details.")
            return
        }

        // #552: the draft rules gate the OUTWARD action, not the save. The screen
        // already disables Send while [KinTaleUiState.sendBlocker] is non-null, so
        // this is the guard behind the disabled control rather than the only one:
        // a send arriving any other way (a stale recomposition, a later caller)
        // still has to pass the same rule the operator was shown.
        state.sendBlocker?.let { blocker ->
            _uiState.value = _uiState.value.copy(error = blocker)
            return
        }

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSending = true)
            // Persist the latest state first (creating the record if this is its
            // first write), as the same field-level diff an ordinary save uses.
            //
            // A REJECTED PRE-SEND SAVE NOW ABORTS THE SEND. This used to be
            // `.getOrNull()` on both branches, so a write the server refused was
            // discarded and the notification went out anyway - announcing to the
            // kinfolk a KinTale whose content the server never took. The auntie saw
            // "sent" and the tale that arrived was the previous revision.
            val baseline = reportBaseline
            val preSave: Result<Unit> = if (baseline == null) {
                kinCareRepository.createKinCareReport(report).map { newId ->
                    reportBaseline = report.copy(id = newId)
                    reportExistsOnServer = true
                    _uiState.value = _uiState.value.copy(report = _uiState.value.report.copy(id = newId))
                }
            } else {
                val changes = kinCareReportFieldChanges(baseline, report)
                if (changes.isEmpty()) {
                    Result.success(Unit)
                } else {
                    kinCareRepository.updateKinCareReportFields(report.id, changes)
                        .map { reportBaseline = report }
                }
            }
            preSave.onFailure { e ->
                AuntieLog.e("KinTale pre-send save failed", e)
                _uiState.value = _uiState.value.copy(
                    isSending = false,
                    saveStatus = SaveStatus.ERROR,
                    error = "Couldn't save before sending: ${e.message ?: "unknown error"}",
                )
                return@launch
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
                    kinCareRepository.markReportSent(
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
            // includePhotos passed EXPLICITLY rather than left to the default, so
            // this call site says what it shares instead of inheriting it (#579).
            kinCareRepository.createShareLink(
                reportId = report.id,
                familyId = report.kinfolkId,
                includePhotos = true,
            ).fold(
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
