package com.tribetails.auntieos.ui.marketing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.mintBlastIdempotencyKey
import com.tribetails.auntieos.ui.communicate.AudienceSegment
import com.tribetails.auntieos.ui.communicate.BroadcastCriteria
import com.tribetails.auntieos.ui.communicate.SegmentKind
import com.tribetails.auntieos.ui.communicate.TagMatch
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Marketing blasts (scheduled campaigns), AuntieOS Android.
 *
 * Parity with the React admin's `screens/MarketingBlasts.tsx`: the same four
 * callables, the same three audience modes, the same four-way reach breakdown,
 * and the same refusal to draw a number the backend does not have (no "sending"
 * progress, no open rate).
 *
 * Every decision this screen makes lives in `MarketingBlast.kt` as a pure
 * function, so it is unit-tested rather than driven through Compose.
 */
data class MarketingBlastsUiState(
    // Compose
    val campaignKey: MarketingKey = MarketingKey.Newsletter,
    val title: String = "",
    val mergeFields: List<MergeFieldRow> = listOf(MergeFieldRow()),

    // Audience
    val mode: AudienceMode = AudienceMode.Criteria,
    val criteria: BroadcastCriteria = BroadcastCriteria(),
    val statusesText: String = "",
    val tagsText: String = "",
    val uidsText: String = "",
    val segments: List<AudienceSegment> = emptyList(),
    val segmentsError: String? = null,
    val selectedSegmentId: String? = null,

    // When
    val sendDate: String = "",
    val sendTime: String = "",

    // Preview
    val reach: BlastReach? = null,
    val previewing: Boolean = false,
    val previewError: String? = null,

    // Schedule
    val scheduling: Boolean = false,
    val scheduleError: String? = null,
    val notice: String? = null,
    val confirmOpen: Boolean = false,

    // Campaign list. `null` means "not loaded", never "empty": an unloaded list
    // rendered as empty would tell the operator nothing is scheduled when the
    // read is what actually failed.
    val blasts: List<MarketingBlastRow>? = null,
    val blastsError: String? = null,
    val cancellingId: String? = null,
) {
    val explicitUids: List<String> get() = parseUidList(uidsText)
    val fireAtMs: Long? get() = fireAtMsFrom(sendDate, sendTime)
    val audience: BlastAudience? get() = blastAudience(mode, selectedSegmentId, criteria, explicitUids)

    /** The scheduled rows, and everything else, split the way the screen renders them. */
    val scheduled: List<MarketingBlastRow> get() = blasts.orEmpty().filter { it.status == BlastStatus.Scheduled }
    val history: List<MarketingBlastRow> get() = blasts.orEmpty().filter { it.status != BlastStatus.Scheduled }

    fun blocker(nowMs: Long): String? = blastBlocker(audience, fireAtMs, nowMs, reach?.reachable)
}

class MarketingBlastsViewModel(private val repo: AuntieRepository) : ViewModel() {

    private val _uiState = MutableStateFlow(MarketingBlastsUiState())
    val uiState: StateFlow<MarketingBlastsUiState> = _uiState.asStateFlow()

    /**
     * #814: the key that makes pressing Schedule twice safe.
     *
     * Minted on the first attempt at a campaign and held for every retry of it,
     * the automatic one inside `AuntieRepository.invokeSend` and the operator's
     * own after seeing an error. Both are the SAME submission, and reusing the
     * key is what makes the server hand back the blast the first attempt created
     * instead of queueing a second set of marketing emails to real households.
     *
     * Dropped the moment any part of the campaign changes, which is the case a
     * held key would get WRONG: a stale key would replay the first attempt's
     * campaign and report success for an edit that never left the phone. That
     * is enforced by comparing [campaignSignature] at send time rather than by
     * asking every setter to remember, which is the same discipline
     * `CommunicateViewModel` uses and is what a new setter cannot break.
     */
    private var submissionKey: String? = null
    private var submissionSignature: String? = null

    init {
        loadSegments()
        loadBlasts()
    }

    // ── audience form ────────────────────────────────────────────────────────

    /**
     * A preview describes ONE audience selection. The moment the selection
     * changes the number on screen is about something else, so it is dropped
     * rather than left to be read as current. Every audience setter funnels
     * through here.
     */
    private fun update(block: (MarketingBlastsUiState) -> MarketingBlastsUiState) {
        _uiState.value = block(_uiState.value)
    }

    /**
     * Everything that decides WHAT is sent and WHEN (#814). Deliberately
     * excludes the transient fields (busy flags, notices, errors, the loaded
     * campaign list, the preview) because those change while a send is in
     * flight, and treating that as an edit would mint a new key for the retry
     * and re-arm the duplicate.
     */
    private fun campaignSignature(s: MarketingBlastsUiState): String = listOf(
        s.campaignKey.wire,
        s.title,
        s.mode.name,
        s.criteria.toString(),
        s.statusesText,
        s.tagsText,
        s.uidsText,
        s.selectedSegmentId.orEmpty(),
        s.mergeFields.toString(),
        s.sendDate,
        s.sendTime,
    ).joinToString("\u001F") // a separator no typed field can contain

    private fun audienceChanged(block: (MarketingBlastsUiState) -> MarketingBlastsUiState) {
        update { block(it).copy(reach = null, previewError = null) }
    }

    fun setCampaignKey(key: MarketingKey) = audienceChanged { it.copy(campaignKey = key) }
    fun setTitle(text: String) = update { it.copy(title = text) }
    fun setMode(mode: AudienceMode) = audienceChanged { it.copy(mode = mode) }
    fun setSelectedSegment(id: String?) = audienceChanged { it.copy(selectedSegmentId = id) }
    fun setUidsText(text: String) = audienceChanged { it.copy(uidsText = text) }

    fun setCriteriaKind(kind: SegmentKind) = audienceChanged {
        it.copy(criteria = it.criteria.copy(kind = kind))
    }

    fun setStatusesText(text: String) = audienceChanged {
        it.copy(statusesText = text, criteria = it.criteria.copy(statuses = splitList(text)))
    }

    fun setTagsText(text: String) = audienceChanged {
        it.copy(tagsText = text, criteria = it.criteria.copy(tags = splitList(text)))
    }

    fun setTagMatch(match: TagMatch) = audienceChanged {
        it.copy(criteria = it.criteria.copy(tagMatch = match))
    }

    fun setSendDate(date: String) = update { it.copy(sendDate = date) }
    fun setSendTime(time: String) = update { it.copy(sendTime = time) }

    fun setMergeFieldKey(index: Int, key: String) = update { s ->
        s.copy(mergeFields = s.mergeFields.mapIndexed { i, r -> if (i == index) r.copy(key = key) else r })
    }

    fun setMergeFieldValue(index: Int, value: String) = update { s ->
        s.copy(mergeFields = s.mergeFields.mapIndexed { i, r -> if (i == index) r.copy(value = value) else r })
    }

    fun addMergeField() = update { it.copy(mergeFields = it.mergeFields + MergeFieldRow()) }

    fun openConfirm() = update { it.copy(confirmOpen = true, scheduleError = null, notice = null) }
    fun closeConfirm() = update { it.copy(confirmOpen = false) }
    fun clearNotice() = update { it.copy(notice = null) }

    // ── loads ────────────────────────────────────────────────────────────────

    fun loadSegments() {
        viewModelScope.launch {
            repo.listAudienceSegments().fold(
                onSuccess = { update { s -> s.copy(segments = it, segmentsError = null) } },
                onFailure = { e ->
                    // Fail loud but non-blocking: saved segments are an
                    // accelerator, and an inline audience is still schedulable.
                    AuntieLog.e("listAudienceSegments failed", e)
                    update {
                        it.copy(
                            segmentsError = "Saved segments could not be loaded: ${e.message ?: "unknown error"}. " +
                                "You can still build an audience below.",
                        )
                    }
                },
            )
        }
    }

    fun loadBlasts() {
        viewModelScope.launch {
            repo.listMarketingBlasts().fold(
                onSuccess = { update { s -> s.copy(blasts = it, blastsError = null) } },
                onFailure = { e ->
                    AuntieLog.e("listMarketingBlasts failed", e)
                    update { it.copy(blasts = null, blastsError = blastErrorText(e.message ?: "Could not load campaigns")) }
                },
            )
        }
    }

    // ── preview ──────────────────────────────────────────────────────────────

    fun previewAudience() {
        val state = _uiState.value
        val audience = state.audience ?: return
        if (state.previewing || state.scheduling) return
        update { it.copy(previewing = true, previewError = null) }
        viewModelScope.launch {
            repo.previewMarketingBlastAudience(state.campaignKey, audience).fold(
                onSuccess = { update { s -> s.copy(reach = it, previewing = false) } },
                onFailure = { e ->
                    update {
                        it.copy(
                            reach = null,
                            previewing = false,
                            previewError = blastErrorText(e.message ?: "Could not check this audience"),
                        )
                    }
                },
            )
        }
    }

    // ── schedule ─────────────────────────────────────────────────────────────

    fun schedule(nowMs: Long = System.currentTimeMillis()) {
        val state = _uiState.value
        val audience = state.audience ?: return
        val fireAtMs = state.fireAtMs ?: return
        if (state.scheduling || state.blocker(nowMs) != null) return
        update { it.copy(scheduling = true, scheduleError = null) }
        // #814: one key per campaign, re-minted only when the campaign itself
        // has changed since the key was minted.
        val signature = campaignSignature(state)
        if (submissionKey == null || submissionSignature != signature) {
            submissionKey = mintBlastIdempotencyKey()
            submissionSignature = signature
        }
        val key = submissionKey
        viewModelScope.launch {
            repo.scheduleMarketingBlast(
                key = state.campaignKey,
                fireAtMs = fireAtMs,
                audience = audience,
                data = mergeFieldsToData(state.mergeFields),
                title = state.title,
                idempotencyKey = key,
            ).fold(
                onSuccess = { result ->
                    submissionKey = null
                    update {
                        it.copy(
                            scheduling = false,
                            confirmOpen = false,
                            reach = null,
                            notice = scheduleNotice(result, fireLabel(fireAtMs)),
                        )
                    }
                    loadBlasts()
                },
                onFailure = { e ->
                    update {
                        it.copy(
                            scheduling = false,
                            confirmOpen = false,
                            scheduleError = blastErrorText(e.message ?: "Could not schedule this blast"),
                        )
                    }
                },
            )
        }
    }

    // ── cancel ───────────────────────────────────────────────────────────────

    fun cancel(blastId: String) {
        if (_uiState.value.cancellingId != null) return
        update { it.copy(cancellingId = blastId, blastsError = null, notice = null) }
        viewModelScope.launch {
            repo.cancelMarketingBlast(blastId).fold(
                onSuccess = { removed ->
                    val word = if (removed == 1) "notification" else "notifications"
                    update { it.copy(cancellingId = null, notice = "Cancelled. $removed queued $word removed.") }
                    loadBlasts()
                },
                onFailure = { e ->
                    update {
                        it.copy(
                            cancellingId = null,
                            blastsError = blastErrorText(e.message ?: "Could not cancel this blast"),
                        )
                    }
                },
            )
        }
    }
}

/** Splits a comma-separated field into trimmed, non-blank entries. Pure. */
internal fun splitList(raw: String): List<String> =
    raw.split(',').map { it.trim() }.filter { it.isNotEmpty() }
