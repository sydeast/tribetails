package com.tribetails.auntieos.ui.communicate

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.RecentSend
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.isValidEmail
import com.tribetails.auntieos.util.isValidPhone
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Blog/social are recipient-less (spec 19 item 2); everything else needs a recipient. Pure; tested. */
internal fun needsRecipient(commType: String): Boolean =
    commType != "blog_post" && commType != "social_post"

/** External-send channel. Mirrors the sendExternalMessage callable's `channel` enum. */
enum class ExternalChannel(val wire: String) { Email("email"), Sms("sms") }

/**
 * Pure client-side validation of the external-send form. Mirrors the server's
 * (sendExternalMessage) gate so the operator gets immediate, honest feedback before
 * a round-trip: email needs a valid address + non-blank subject; SMS needs a valid
 * phone; both need a non-blank body. Returns the first human-readable problem, or
 * null when the form is sendable. Reuses [isValidEmail] / [isValidPhone] so the
 * client and the Kinfolk forms agree on what valid means. Pure; unit-tested.
 */
internal fun validateExternalSend(
    channel: ExternalChannel,
    to: String,
    subject: String,
    body: String,
): String? {
    val recipient = to.trim()
    if (recipient.isBlank()) return "Recipient is required."
    when (channel) {
        ExternalChannel.Email -> {
            if (!isValidEmail(recipient)) return "Enter a valid email address."
            if (subject.isBlank()) return "Subject is required for email."
        }
        ExternalChannel.Sms -> {
            if (!isValidPhone(recipient)) return "Enter a valid phone number."
        }
    }
    if (body.isBlank()) return "Message body is required."
    return null
}

data class CommunicateUiState(
    // Form
    val commType: String = "visit_report",
    val selectedKinfolk: Kinfolk? = null,
    val toneHint: String = "warm",
    val messageLength: String = "medium",
    val rawNotes: String = "",
    val subject: String = "",

    // Dropdowns
    val kinfolkList: List<Kinfolk> = emptyList(),
    val kinfolkLoading: Boolean = true,

    // Profile panels
    val dossier: Dossier? = null,
    val kin: List<Kin> = emptyList(),
    val kin411Map: Map<String, Kin411> = emptyMap(), // kinId -> 411
    val profileLoading: Boolean = false,
    val isSynthesizing: Boolean = false,

    // Recipient comms box ("where things last left off" / latest message). Driven by
    // loadCommsBox; the AI recap variant is gated behind communicate.commsRecap.
    val commsBox: CommsBoxState = CommsBoxState.Empty,
    val commsBoxLoading: Boolean = false,
    val commsRecapError: String? = null,

    // Generation
    val isGenerating: Boolean = false,
    val generatedCopy: String = "",
    val draftId: String? = null,
    val kinfolkId: String? = null,
    val generatedKinfolkName: String = "",
    val generatedCommType: String = "",
    val generatedModel: String = "",

    // Approval
    val isSaving: Boolean = false,
    val savedDraftId: String? = null,

    // External send (one-off email/SMS to an arbitrary recipient, not a kinfolk).
    val externalChannel: ExternalChannel = ExternalChannel.Email,
    val externalTo: String = "",
    val externalSubject: String = "",
    val externalBody: String = "",
    val isSendingExternal: Boolean = false,
    val externalError: String? = null,
    val externalSentRedacted: String? = null, // server-redacted recipient on success
    val isSuppressing: Boolean = false,
    val externalSuppressedRedacted: String? = null,

    // Broadcast (Stage 2 step 6: saved segments + multichannel fan-out).
    val segments: List<AudienceSegment> = emptyList(),
    val segmentsLoading: Boolean = false,
    val selectedSegmentId: String? = null, // null = ad-hoc criteria
    val bcKind: SegmentKind = SegmentKind.All,
    val bcStatusesText: String = "",
    // "By tag" audience: names chosen from the household tag vocabulary, already
    // carrying the vocabulary's casing because the server compares tag strings
    // exactly (audienceCriteria.ts). [bcTagQuery] is the autocomplete input.
    val bcSelectedTags: List<String> = emptyList(),
    val bcTagQuery: String = "",
    val bcTagMatch: TagMatch = TagMatch.Any,
    // The household tag vocabulary (business_settings.householdTags). HOUSEHOLD
    // ONLY: the criteria schema has no pet-tag kind, so a pet tag offered here
    // would build an audience the server ignores.
    val householdTagVocab: List<TagDef> = emptyList(),
    val tagVocabLoaded: Boolean = false,
    val tagVocabError: String? = null,
    val bcNewSegmentName: String = "",
    val bcChannels: Set<BroadcastChannel> = setOf(BroadcastChannel.InApp),
    val bcSubject: String = "",
    val bcBody: String = "",
    val isBroadcasting: Boolean = false,
    val isSavingSegment: Boolean = false,
    val broadcastResult: BroadcastResult? = null,
    val broadcastError: String? = null,

    // Recent sends + engagement (Communicate "Recent" panel; counts from the webhooks).
    val recentSends: List<RecentSend> = emptyList(),
    val recentSendsLoading: Boolean = true,
    val recentSendsError: String? = null,

    // Errors / status
    val error: String? = null,
    val successMessage: String? = null
)

class CommunicateViewModel(private val repo: AuntieRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(CommunicateUiState())
    val uiState: StateFlow<CommunicateUiState> = _uiState.asStateFlow()

    init {
        AuntieLog.d("CommunicateViewModel initialized")
        loadKinfolk()
        // loadRecentSends() is triggered by the screen (LaunchedEffect), not init, so
        // unit tests that mock the repo without stubbing listRecentSends still construct.
    }

    /** Communicate "Recent": load recent external sends + engagement counts. */
    fun loadRecentSends() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(recentSendsLoading = true, recentSendsError = null)
            repo.listRecentSends().fold(
                onSuccess = { _uiState.value = _uiState.value.copy(recentSends = it, recentSendsLoading = false) },
                onFailure = {
                    _uiState.value = _uiState.value.copy(
                        recentSendsLoading = false,
                        recentSendsError = it.message ?: "Could not load recent sends",
                    )
                },
            )
        }
    }

    private fun loadKinfolk() {
        AuntieLog.d("Loading kinfolk for communicate screen")
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(kinfolkLoading = true, error = null)
            repo.getKinfolk().onSuccess { list ->
                AuntieLog.d("Loaded ${list.size} kinfolk for communication")
                _uiState.value = _uiState.value.copy(kinfolkList = list, kinfolkLoading = false)
            }.onFailure { e ->
                AuntieLog.e("Failed to load kinfolk for communication", e)
                _uiState.value = _uiState.value.copy(kinfolkLoading = false, error = "Could not load Kinfolk")
            }
        }
    }

    fun setCommType(type: String) { _uiState.value = _uiState.value.copy(commType = type) }
    fun setSubject(s: String) { _uiState.value = _uiState.value.copy(subject = s) }
    fun setToneHint(tone: String) { _uiState.value = _uiState.value.copy(toneHint = tone) }
    fun setMessageLength(len: String) { _uiState.value = _uiState.value.copy(messageLength = len) }
    fun setRawNotes(notes: String) { _uiState.value = _uiState.value.copy(rawNotes = notes) }
    fun setGeneratedCopy(text: String) { _uiState.value = _uiState.value.copy(generatedCopy = text) }
    fun clearError() { _uiState.value = _uiState.value.copy(error = null) }
    fun clearSuccess() { _uiState.value = _uiState.value.copy(successMessage = null) }

    fun selectKinfolk(kinfolk: Kinfolk?) {
        AuntieLog.d("Kinfolk selected: ${kinfolk?.displayName ?: "none"}")
        _uiState.value = _uiState.value.copy(
            selectedKinfolk = kinfolk,
            dossier = null,
            kin = emptyList(),
            kin411Map = emptyMap(),
            commsBox = CommsBoxState.Empty,
            commsRecapError = null,
        )
        if (kinfolk != null) loadProfiles(kinfolk)
    }

    /**
     * Loads the recipient comms box for [kinfolkId]. Reads the four comms channels
     * (fail-loud: a read failure surfaces in commsRecapError and resets the box to
     * Empty), picks the single latest message, and - only when [recapFlagOn] - calls
     * the admin-gated recap callable. A recap failure is disclosed (commsRecapError)
     * and the box falls back to the raw latest message. The flag value is passed in
     * by the screen so the ViewModel stays free of Compose plumbing.
     */
    fun loadCommsBox(kinfolkId: String, recapFlagOn: Boolean) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(commsBoxLoading = true, commsRecapError = null)
            val comms = repo.recentCommsForKinfolk(kinfolkId).getOrElse {
                AuntieLog.e("loadCommsBox: recent comms read failed for $kinfolkId", it)
                _uiState.value = _uiState.value.copy(
                    commsBoxLoading = false,
                    commsBox = CommsBoxState.Empty,
                    commsRecapError = "Couldn't load recent messages: ${it.message}",
                )
                return@launch
            }
            val latest = latestCommunication(comms.sms, comms.emails, comms.calls, comms.voicemails)
            var recap: String? = null
            var recapErr: String? = null
            if (recapFlagOn) {
                repo.recapRecentComms(kinfolkId)
                    .onSuccess { recap = it.recap }
                    .onFailure {
                        AuntieLog.e("loadCommsBox: recap failed for $kinfolkId", it)
                        recapErr = it.message
                    }
            }
            _uiState.value = _uiState.value.copy(
                commsBoxLoading = false,
                commsBox = commsBoxState(recapFlagOn, recap, latest),
                commsRecapError = recapErr,
            )
        }
    }

    fun prefillFromCall(kinfolkId: String?, transcript: String) {
        AuntieLog.i("Prefilling communication from call - kinfolkId: $kinfolkId")
        val kinfolk = _uiState.value.kinfolkList.find { it.id == kinfolkId }
        _uiState.value = _uiState.value.copy(
            selectedKinfolk = kinfolk,
            rawNotes = transcript,
            commType = "visit_report"
        )
        if (kinfolk != null) loadProfiles(kinfolk)
    }

    fun synthesizeProfile() {
        val kinfolkId = _uiState.value.selectedKinfolk?.id ?: run {
            _uiState.value = _uiState.value.copy(error = "No Kinfolk selected for profile synthesis.")
            return
        }
        AuntieLog.i("Starting profile synthesis for $kinfolkId")
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSynthesizing = true, error = null)
            repo.synthesizeProfile(kinfolkId).onSuccess {
                AuntieLog.i("Profile synthesis successful")
                _uiState.value = _uiState.value.copy(isSynthesizing = false, successMessage = "Profile updated from recent history.")
                loadProfiles(_uiState.value.selectedKinfolk!!)
            }.onFailure { e ->
                AuntieLog.e("Synthesis failed", e)
                _uiState.value = _uiState.value.copy(isSynthesizing = false, error = "Synthesis failed: ${e.message}")
            }
        }
    }

    private fun loadProfiles(kinfolk: Kinfolk) {
        AuntieLog.d("Loading related profiles for ${kinfolk.id}")
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(profileLoading = true)
            try {
                val dossierDeferred = async { repo.getDossier(kinfolk.id) }
                val kinDeferred     = async { repo.getKin(kinfolk.id) }

                val dossier = dossierDeferred.await().getOrNull()
                val kinList = kinDeferred.await().getOrDefault(emptyList())

                val kin411Map = mutableMapOf<String, Kin411>()
                kinList.map { kin ->
                    async { repo.get411ForKin(kin.id).getOrNull()?.let { kin411Map[kin.id] = it } }
                }.forEach { it.await() }

                AuntieLog.d("Related profiles loaded for ${kinfolk.id}")
                _uiState.value = _uiState.value.copy(
                    dossier = dossier,
                    kin = kinList,
                    kin411Map = kin411Map,
                    profileLoading = false
                )
            } catch (e: Exception) {
                AuntieLog.e("Failed to load related profiles", e)
                _uiState.value = _uiState.value.copy(profileLoading = false, error = "Failed to load profiles")
            }
        }
    }

    fun generate(useFunction: Boolean = true) {
        val state = _uiState.value
        if (state.rawNotes.isBlank()) {
            AuntieLog.w("Generation attempted without raw notes")
            _uiState.value = state.copy(error = "Raw notes are required.")
            return
        }
        // Blog/social are recipient-less (spec 19 item 2); the rest need a recipient.
        if (needsRecipient(state.commType) && state.selectedKinfolk == null) {
            _uiState.value = state.copy(error = "Pick a recipient for this message type first.")
            return
        }
        if (state.isGenerating) {
            AuntieLog.w("Generation already in progress - ignoring duplicate call")
            return
        }

        AuntieLog.i("Generating communication content type: ${state.commType}")
        _uiState.value = state.copy(isGenerating = true, error = null, generatedCopy = "")
        viewModelScope.launch {

            val request = GenerateRequest(
                communication_type = state.commType,
                recipient          = if (needsRecipient(state.commType)) state.selectedKinfolk?.displayName ?: "" else "",
                raw_notes          = state.rawNotes,
                tone_hint          = state.toneHint,
                max_length         = state.messageLength,
                // Regenerate: nudge a different opener than the draft being replaced.
                avoid_opening      = state.generatedCopy.trim().takeWhile { !it.isWhitespace() }.ifBlank { null },
            )

            repo.generate(request, useFunction).onSuccess { result ->
                AuntieLog.i("Content generation successful")
                _uiState.value = _uiState.value.copy(
                    isGenerating          = false,
                    generatedCopy         = result.generatedCopy,
                    draftId               = result.draftId,
                    kinfolkId             = result.kinfolkId,
                    generatedKinfolkName  = result.kinfolkName,
                    generatedCommType     = result.communicationType,
                    generatedModel        = result.model,
                    savedDraftId          = null
                )
            }.onFailure { e ->
                AuntieLog.e("Content generation failed", e)
                _uiState.value = _uiState.value.copy(
                    isGenerating = false,
                    error = e.message ?: "Generation failed"
                )
            }
        }
    }

    fun approveDraft() {
        val state = _uiState.value
        val draftId = state.draftId ?: run {
            AuntieLog.w("Approval attempted without draft ID")
            _uiState.value = state.copy(error = "No draft to save.")
            return
        }

        AuntieLog.i("Approving and saving draft: $draftId")
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true, error = null)
            repo.approveDraft(draftId, state.generatedCopy, state.kinfolkId)
                .onSuccess {
                    AuntieLog.i("Draft #$draftId saved successfully")
                    _uiState.value = _uiState.value.copy(
                        isSaving       = false,
                        savedDraftId   = draftId,
                        successMessage = "Draft #$draftId saved."
                    )
                }
                .onFailure { e ->
                    AuntieLog.e("Failed to save draft", e)
                    _uiState.value = _uiState.value.copy(
                        isSaving = false,
                        error    = e.message ?: "Save failed"
                    )
                }
        }
    }

    // ── External send (one-off email/SMS to an arbitrary recipient) ──────────────

    fun setExternalChannel(channel: ExternalChannel) {
        _uiState.value = _uiState.value.copy(
            externalChannel = channel,
            // A redacted-success banner is for the prior recipient; clear stale state.
            externalError = null,
            externalSentRedacted = null,
            externalSuppressedRedacted = null,
        )
    }

    fun setExternalTo(value: String) {
        _uiState.value = _uiState.value.copy(externalTo = value, externalError = null)
    }

    fun setExternalSubject(value: String) {
        _uiState.value = _uiState.value.copy(externalSubject = value, externalError = null)
    }

    fun setExternalBody(value: String) {
        _uiState.value = _uiState.value.copy(externalBody = value, externalError = null)
    }

    fun clearExternalError() { _uiState.value = _uiState.value.copy(externalError = null) }
    fun clearExternalSent() { _uiState.value = _uiState.value.copy(externalSentRedacted = null) }
    fun clearExternalSuppressed() { _uiState.value = _uiState.value.copy(externalSuppressedRedacted = null) }

    /**
     * Sends the external-send form via the deployed sendExternalMessage callable.
     * Validates client-side first (fail fast, no round-trip), then surfaces the
     * server-redacted recipient on success or the verbatim server error (including
     * 'recipient_opted_out') on failure. */
    fun sendExternal() {
        val s = _uiState.value
        val problem = validateExternalSend(s.externalChannel, s.externalTo, s.externalSubject, s.externalBody)
        if (problem != null) {
            AuntieLog.w("External send blocked client-side: $problem")
            _uiState.value = s.copy(externalError = problem)
            return
        }
        if (s.isSendingExternal) {
            AuntieLog.w("External send already in progress - ignoring duplicate call")
            return
        }
        AuntieLog.i("Sending external ${s.externalChannel.wire} message")
        _uiState.value = s.copy(
            isSendingExternal = true,
            externalError = null,
            externalSentRedacted = null,
            externalSuppressedRedacted = null,
        )
        viewModelScope.launch {
            repo.sendExternalMessage(
                channel = s.externalChannel.wire,
                to = s.externalTo.trim(),
                subject = s.externalSubject.takeIf { s.externalChannel == ExternalChannel.Email },
                body = s.externalBody,
            ).onSuccess { result ->
                AuntieLog.i("External send ok: ${result.recipientRedacted}")
                _uiState.value = _uiState.value.copy(
                    isSendingExternal = false,
                    externalSentRedacted = result.recipientRedacted,
                    externalError = null,
                )
            }.onFailure { e ->
                AuntieLog.e("External send failed", e)
                _uiState.value = _uiState.value.copy(
                    isSendingExternal = false,
                    externalError = e.message ?: "External send failed",
                )
            }
        }
    }

    /**
     * Records an opt-out for the form's current recipient via the deployed
     * suppressExternalRecipient callable. After this the server consent gate blocks
     * future sends to that recipient. */
    fun suppressExternal() {
        val s = _uiState.value
        val recipient = s.externalTo.trim()
        val valid = when (s.externalChannel) {
            ExternalChannel.Email -> isValidEmail(recipient)
            ExternalChannel.Sms -> isValidPhone(recipient)
        }
        if (!valid) {
            val msg = if (s.externalChannel == ExternalChannel.Email)
                "Enter a valid email address to suppress."
            else
                "Enter a valid phone number to suppress."
            _uiState.value = s.copy(externalError = msg)
            return
        }
        if (s.isSuppressing) return
        AuntieLog.i("Suppressing external ${s.externalChannel.wire} recipient")
        _uiState.value = s.copy(isSuppressing = true, externalError = null, externalSuppressedRedacted = null)
        viewModelScope.launch {
            repo.suppressExternalRecipient(channel = s.externalChannel.wire, to = recipient)
                .onSuccess { result ->
                    AuntieLog.i("External recipient suppressed: ${result.recipientRedacted}")
                    _uiState.value = _uiState.value.copy(
                        isSuppressing = false,
                        externalSuppressedRedacted = result.recipientRedacted,
                        externalError = null,
                    )
                }
                .onFailure { e ->
                    AuntieLog.e("External suppress failed", e)
                    _uiState.value = _uiState.value.copy(
                        isSuppressing = false,
                        externalError = e.message ?: "Suppression failed",
                    )
                }
        }
    }

    // ── Broadcast (Stage 2 step 6) ────────────────────────────────────────────

    private fun adhocCriteria(s: CommunicateUiState = _uiState.value): BroadcastCriteria = BroadcastCriteria(
        kind = s.bcKind,
        statuses = s.bcStatusesText.split(',').map { it.trim() }.filter { it.isNotEmpty() },
        // Already normalized and deduped by the picker, and carrying the
        // vocabulary's casing, which is what the server compares against.
        tags = s.bcSelectedTags,
        tagMatch = s.bcTagMatch,
    )

    /**
     * The one tag problem that genuinely stops a send: over the server's cap the
     * whole call is rejected, so blocking here with readable copy beats letting
     * Zod answer. Only applies to an ad-hoc tag audience; a saved segment was
     * validated when it was saved.
     */
    private fun tagCapProblem(s: CommunicateUiState): String? =
        if (s.selectedSegmentId == null && s.bcKind == SegmentKind.Tags) {
            broadcastTagCapProblem(s.bcSelectedTags)
        } else {
            null
        }

    fun selectSegment(id: String?) { _uiState.value = _uiState.value.copy(selectedSegmentId = id, broadcastError = null) }
    fun setBcKind(kind: SegmentKind) { _uiState.value = _uiState.value.copy(bcKind = kind) }
    fun setBcStatuses(text: String) { _uiState.value = _uiState.value.copy(bcStatusesText = text) }
    fun setBcTagMatch(m: TagMatch) { _uiState.value = _uiState.value.copy(bcTagMatch = m) }

    // ── "By tag" audience picker ──────────────────────────────────────────────

    fun setBcTagQuery(q: String) { _uiState.value = _uiState.value.copy(bcTagQuery = q) }

    /**
     * Add a tag to the audience and clear the query. Takes the vocabulary's
     * casing when the name matches an entry, because the server matches tag
     * strings exactly. A blank name and a case-insensitive duplicate are no-ops.
     */
    fun addBcTag(name: String) {
        val s = _uiState.value
        _uiState.value = s.copy(
            bcSelectedTags = addBroadcastTag(s.bcSelectedTags, name, s.householdTagVocab),
            bcTagQuery = "",
            broadcastError = null,
        )
    }

    /** Drop a tag from the audience (case-insensitive), preserving order. */
    fun removeBcTag(name: String) {
        val s = _uiState.value
        _uiState.value = s.copy(bcSelectedTags = removeBroadcastTag(s.bcSelectedTags, name), broadcastError = null)
    }

    /**
     * Load the household tag vocabulary the picker chooses from. Screen-driven
     * (a LaunchedEffect in the Broadcast section), not init, so a screen that
     * never opens Broadcast does not pay for the read.
     *
     * A failed read is surfaced, never swallowed: the field stays usable so the
     * operator can still type a name, and the banner says why the list is empty
     * rather than implying there are no tags.
     */
    fun loadHouseholdTagVocab() {
        viewModelScope.launch {
            repo.getBusinessSettings()
                .onSuccess { settings ->
                    _uiState.value = _uiState.value.copy(
                        householdTagVocab = settings.householdTagDefs(),
                        tagVocabLoaded = true,
                        tagVocabError = null,
                    )
                }
                .onFailure { e ->
                    AuntieLog.e("loadHouseholdTagVocab failed", e)
                    _uiState.value = _uiState.value.copy(
                        tagVocabLoaded = false,
                        tagVocabError = e.message ?: "Could not load your tag list",
                    )
                }
        }
    }
    fun setBcNewSegmentName(name: String) { _uiState.value = _uiState.value.copy(bcNewSegmentName = name) }
    fun setBcSubject(s: String) { _uiState.value = _uiState.value.copy(bcSubject = s, broadcastError = null) }
    fun setBcBody(b: String) { _uiState.value = _uiState.value.copy(bcBody = b, broadcastError = null) }
    fun clearBroadcastError() { _uiState.value = _uiState.value.copy(broadcastError = null) }
    fun clearBroadcastResult() { _uiState.value = _uiState.value.copy(broadcastResult = null) }

    fun toggleBcChannel(ch: BroadcastChannel) {
        val cur = _uiState.value.bcChannels
        _uiState.value = _uiState.value.copy(
            bcChannels = if (ch in cur) cur - ch else cur + ch,
            broadcastError = null,
        )
    }

    fun setBcChannels(chs: Set<BroadcastChannel>) {
        _uiState.value = _uiState.value.copy(bcChannels = chs, broadcastError = null)
    }

    fun loadSegments() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(segmentsLoading = true)
            repo.listAudienceSegments()
                .onSuccess { _uiState.value = _uiState.value.copy(segments = it, segmentsLoading = false) }
                .onFailure { e ->
                    AuntieLog.e("loadSegments failed", e)
                    _uiState.value = _uiState.value.copy(segmentsLoading = false, broadcastError = "Could not load segments: ${e.message}")
                }
        }
    }

    fun saveSegment() {
        val s = _uiState.value
        val criteria = adhocCriteria(s)
        val problem = tagCapProblem(s) ?: segmentSaveBlocker(s.bcNewSegmentName, criteria)
        if (problem != null) { _uiState.value = s.copy(broadcastError = problem); return }
        if (s.isSavingSegment) return
        _uiState.value = s.copy(isSavingSegment = true, broadcastError = null)
        viewModelScope.launch {
            repo.saveAudienceSegment(id = null, name = s.bcNewSegmentName.trim(), criteria = criteria)
                .onSuccess { newId ->
                    _uiState.value = _uiState.value.copy(
                        isSavingSegment = false,
                        bcNewSegmentName = "",
                        selectedSegmentId = newId,
                        successMessage = "Segment saved.",
                    )
                    loadSegments()
                }
                .onFailure { e ->
                    AuntieLog.e("saveSegment failed", e)
                    _uiState.value = _uiState.value.copy(isSavingSegment = false, broadcastError = e.message ?: "Save failed")
                }
        }
    }

    fun deleteSegment(id: String) {
        viewModelScope.launch {
            repo.deleteAudienceSegment(id)
                .onSuccess {
                    val cur = _uiState.value
                    _uiState.value = cur.copy(
                        selectedSegmentId = if (cur.selectedSegmentId == id) null else cur.selectedSegmentId,
                        successMessage = "Segment deleted.",
                    )
                    loadSegments()
                }
                .onFailure { e ->
                    AuntieLog.e("deleteSegment failed", e)
                    _uiState.value = _uiState.value.copy(broadcastError = e.message ?: "Delete failed")
                }
        }
    }

    fun sendBroadcast() {
        val s = _uiState.value
        val criteria = if (s.selectedSegmentId == null) adhocCriteria(s) else null
        val effective = criteria ?: s.segments.firstOrNull { it.id == s.selectedSegmentId }?.criteria ?: BroadcastCriteria()
        val problem = tagCapProblem(s) ?: broadcastBlocker(s.bcChannels, effective, s.bcSubject, s.bcBody)
        if (problem != null) { _uiState.value = s.copy(broadcastError = problem); return }
        if (s.isBroadcasting) return
        _uiState.value = s.copy(isBroadcasting = true, broadcastError = null, broadcastResult = null)
        viewModelScope.launch {
            repo.broadcastMessage(
                segmentId = s.selectedSegmentId,
                criteria = criteria,
                channels = s.bcChannels.toList(),
                subject = s.bcSubject.trim().ifBlank { null },
                body = s.bcBody.trim(),
            ).onSuccess { result ->
                AuntieLog.i("Broadcast ok: ${result.broadcastId}")
                _uiState.value = _uiState.value.copy(isBroadcasting = false, broadcastResult = result, broadcastError = null)
            }.onFailure { e ->
                AuntieLog.e("Broadcast failed", e)
                _uiState.value = _uiState.value.copy(isBroadcasting = false, broadcastError = broadcastErrorText(e.message ?: "Broadcast failed"))
            }
        }
    }
}
