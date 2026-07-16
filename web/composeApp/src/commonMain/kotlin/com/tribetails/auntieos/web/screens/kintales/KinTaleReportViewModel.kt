package com.tribetails.auntieos.web.screens.kintales

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinTaleComment
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * Edit-side state for the KinTale report screen.
 *
 * The live report itself is read straight off [reportStream] by the screen using
 * the project P0-FLICKER `remember { ... }.collectAsState` idiom, so status /
 * delivery-receipt mutations land in the UI as soon as Firestore emits them. This
 * VM only owns the transient *editing* concerns: the in-progress draft body, the
 * send/save lifecycle, and any fail-loud error string. (The old VM took a single
 * `.first()` snapshot and dropped the Flow, so post-load mutations were invisible,
 * and it set `isSent` which immediately popped the screen back, so the published
 * SENT artifact was never actually shown. Both are fixed here.)
 */
class KinTaleReportViewModel(
    private val sessionId: String,
    private val dataSource: AuntieDataSource,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
) {
    /**
     * In-progress edit of the narrative body. `null` means "no local edit yet, use
     * whatever the live report carries". The screen seeds the editor from the live
     * stream and routes keystrokes here, so a live re-emission never clobbers text
     * the auntie is actively typing.
     */
    var bodyDraft: String? by mutableStateOf(null)
        private set

    /**
     * Local edit of the cover headline. Null until the auntie touches it, so a
     * blank title from an untouched report is never overwritten with a derived
     * value. Mirrors [bodyDraft].
     */
    var titleDraft: String? by mutableStateOf(null)
        private set

    var isSending: Boolean by mutableStateOf(false)
        private set

    /**
     * In-flight guard for [saveDraft]. Set synchronously before the save coroutine
     * launches and cleared in a finally, so a double-tap (or an autosave racing a
     * manual save) can't fire two overlapping writes for the same draft (NOTE-63).
     */
    var isSaving: Boolean by mutableStateOf(false)
        private set

    /** True once the auntie's own save has committed at least once this session. */
    var isDraftSaved: Boolean by mutableStateOf(false)
        private set

    /**
     * Set true after this screen's own send succeeds. It does NOT pop the screen.
     * The screen flips to the read-only published artifact view in place, so the
     * auntie actually sees the sent KinTale (audit bug: send used to call onBack()).
     */
    var justSent: Boolean by mutableStateOf(false)
        private set

    var error: String? by mutableStateOf(null)
        private set

    /** Live report for this session. Never `.first()`; the screen collects it. */
    fun reportStream(): Flow<FirestoreResult<KinCareReport?>> =
        dataSource.reportForSessionStream(sessionId)

    /**
     * Live session, used for (a) the SENT report's GPS RouteMap (real persisted
     * [com.tribetails.auntieos.web.data.GpsSummary] route/stats) and (b) the
     * routing keys (kinfolkId + sourceBookingId) the send pipeline passes to the
     * dispatch callable. The screen collects with remember{}.collectAsState
     * (P0-FLICKER).
     */
    fun sessionStream(): Flow<FirestoreResult<KinCareSession?>> =
        dataSource.sessionForIdStream(sessionId)

    /**
     * Live media attached to this visit. KinTale uploads are written with
     * entityType "VISIT_LOG" + entityId == sessionId (see KinTaleMediaConfig
     * folderFor), so this resolves the real photo/video docs the Photos section
     * renders instead of the old placeholder tiles.
     */
    fun mediaStream(): Flow<FirestoreResult<List<MediaFile>>> =
        dataSource.mediaStream(sessionId, "VISIT_LOG")

    /**
     * Live kin (pets) used to join real name/species onto the per-kin checklist
     * headings (spec 11 item 4.1) so a SENT report reads "Biscuit · Dog ·
     * Labrador" instead of a raw kinId. The screen collects it; the join falls
     * back to the raw id when a kin can't be resolved (never invents a name).
     */
    fun kinStream(): Flow<FirestoreResult<List<Kin>>> =
        dataSource.allKinStream()

    /** Routes editor keystrokes into the local draft. */
    fun updateBodyCopy(text: String) {
        bodyDraft = text
        isDraftSaved = false
    }

    /** Routes headline keystrokes into the local draft. Mirrors [updateBodyCopy]. */
    fun updateTitle(text: String) {
        titleDraft = text
        isDraftSaved = false
    }

    /** The headline to render: local edit if touched, else the live report's. */
    fun effectiveTitle(liveTitle: String): String = titleDraft ?: liveTitle

    /**
     * The body to render in the editor: the local edit if the auntie has touched
     * it, otherwise the live report's body.
     */
    fun effectiveBody(liveBody: String): String = bodyDraft ?: liveBody

    /** Persist the current draft. [liveReport] is the latest stream value. */
    fun saveDraft(liveReport: KinCareReport) {
        // In-flight guard (NOTE-63): set synchronously so a second call before the
        // first write returns is dropped, not queued behind it. Mirrors send().
        if (isSaving) return
        isSaving = true
        scope.launch {
            val report = liveReport.copy(
                sessionId = sessionId,
                title = effectiveTitle(liveReport.title),
                bodyCopy = effectiveBody(liveReport.bodyCopy),
            )
            try {
                when (val result = dataSource.saveReport(report)) {
                    is WriteResult.Ok -> {
                        isDraftSaved = true
                        error = null
                    }
                    is WriteResult.Err -> {
                        isDraftSaved = false
                        error = "Save failed: ${result.message}"
                    }
                }
            } finally {
                isSaving = false
            }
        }
    }

    /**
     * Save-if-needed then send. [liveReport] + [liveSession] are the latest stream
     * values. The session carries the kinfolkId + sourceBookingId the dispatch
     * callable needs to route the `report_sent` notification and write a real
     * delivery receipt. Fail-loud: no session, or a dispatch error, blocks the
     * SENT flip so the auntie retries (matches Android).
     */
    fun send(liveReport: KinCareReport, liveSession: KinCareSession?) {
        val body = effectiveBody(liveReport.bodyCopy)
        if (body.isBlank()) {
            error = "Nothing to send yet. Fill in some details first."
            return
        }
        val session = liveSession ?: run {
            error = "Cannot send: this visit's session could not be loaded."
            return
        }
        scope.launch {
            isSending = true
            error = null
            val report = liveReport.copy(sessionId = sessionId, bodyCopy = body)
            val reportId = when (val save = dataSource.saveReport(report)) {
                is WriteResult.Ok -> save.value
                is WriteResult.Err -> {
                    isSending = false
                    error = "Save failed: ${save.message}"
                    return@launch
                }
            }
            when (val result = dataSource.sendReport(report.copy(_id = reportId), session)) {
                is WriteResult.Ok -> {
                    isSending = false
                    // Stop overriding the body with the local draft; the live stream
                    // now carries the canonical sent report (status -> SENT, sentAt,
                    // sentVia, receipt). The screen shows the artifact view in place.
                    bodyDraft = null
                    justSent = true
                    error = null
                }
                is WriteResult.Err -> {
                    isSending = false
                    error = "Send failed: ${result.message}"
                }
            }
        }
    }

    fun clearError() {
        error = null
    }

    // ── View as kinfolk + share link (SENT report) ───────────────────────────
    /**
     * When true, the SENT report renders in a read-only "as a kinfolk would see
     * it" preview: no admin compose box, no Save/Send, no delivery-receipt rail.
     * Toggled by the "View as kinfolk" / "Exit preview" affordance.
     */
    var viewAsKinfolk: Boolean by mutableStateOf(false)
        private set

    /** The minted public share URL, shown + copyable in the share dialog. Null = no link yet. */
    var shareUrl: String? by mutableStateOf(null)
        private set

    /** Controls the share-link dialog's visibility. */
    var shareDialogOpen: Boolean by mutableStateOf(false)
        private set

    var isCreatingShareLink: Boolean by mutableStateOf(false)
        private set

    var shareError: String? by mutableStateOf(null)
        private set

    /** Confirmation flag flipped after a successful clipboard copy. */
    var shareCopied: Boolean by mutableStateOf(false)
        private set

    fun toggleViewAsKinfolk() {
        viewAsKinfolk = !viewAsKinfolk
    }

    fun dismissShareDialog() {
        shareDialogOpen = false
        shareCopied = false
        shareError = null
    }

    /**
     * Mints a read-only public share link for a SENT report and opens the share
     * dialog. [report] must be SENT and carry a non-blank [KinCareReport._id] +
     * [KinCareReport.kinfolkId] (the routing keys the createShareLink callable
     * needs). Fail-loud: a blank id/kinfolk, or a callable error, sets [shareError]
     * and the dialog shows it; no link is fabricated.
     */
    fun createShareLink(report: KinCareReport) {
        val problem = shareLinkPreflightError(report)
        if (problem != null) {
            shareError = problem
            shareDialogOpen = true
            shareUrl = null
            return
        }
        scope.launch {
            isCreatingShareLink = true
            shareError = null
            shareUrl = null
            shareCopied = false
            shareDialogOpen = true
            when (val r = dataSource.createShareLink(report.kinfolkId, report._id, includePhotos = true)) {
                is WriteResult.Ok -> {
                    shareUrl = r.value
                    isCreatingShareLink = false
                }
                is WriteResult.Err -> {
                    shareError = "Could not create a share link: ${r.message}"
                    isCreatingShareLink = false
                }
            }
        }
    }

    /** Copies the minted [shareUrl] to the clipboard (best-effort) and flags it copied. */
    fun copyShareUrl() {
        val url = shareUrl ?: return
        com.tribetails.auntieos.web.util.copyToClipboard(url)
        shareCopied = true
    }

    // ── KinTale comment thread (SENT report) ─────────────────────────────────
    /** In-progress admin comment body. */
    var commentDraft: String by mutableStateOf("")
        private set

    /** Id of the comment being replied to, or null for a top-level comment. */
    var replyTargetId: String? by mutableStateOf(null)
        private set

    var isPostingComment: Boolean by mutableStateOf(false)
        private set

    var commentError: String? by mutableStateOf(null)
        private set

    /** Live comment thread for a SENT report. The screen collects with remember{}.collectAsState (P0-FLICKER). */
    fun commentsStream(taleId: String, kinfolkId: String): Flow<FirestoreResult<List<KinTaleComment>>> =
        dataSource.kinTaleCommentsStream(taleId, kinfolkId)

    fun updateCommentDraft(text: String) {
        commentDraft = text
        if (commentError != null) commentError = null
    }

    /** Set (or clear) the reply target. Passing null returns to top-level compose. */
    fun setReplyTarget(commentId: String?) {
        replyTargetId = commentId
    }

    /**
     * Post the current draft as an admin comment (top-level or reply to [replyTargetId]).
     * Fails loud: blank body sets [commentError] and writes nothing; a server error
     * surfaces "Could not post: ...". On success the draft + reply target clear.
     */
    fun postComment(taleId: String, kinfolkId: String) {
        val body = commentDraft.trim()
        if (body.isBlank()) {
            commentError = "Write something first."
            return
        }
        scope.launch {
            isPostingComment = true
            commentError = null
            when (val result = dataSource.addKinTaleComment(taleId, kinfolkId, body, replyTargetId)) {
                is WriteResult.Ok -> {
                    commentDraft = ""
                    replyTargetId = null
                    isPostingComment = false
                }
                is WriteResult.Err -> {
                    isPostingComment = false
                    commentError = "Could not post: ${result.message}"
                }
            }
        }
    }
}

/**
 * Pure preflight for minting a KinTale share link. Returns a fail-loud reason
 * string when the report cannot be shared, or null when it is shareable.
 *
 * A link can only be created for a SENT report that carries the routing keys the
 * createShareLink callable requires: a saved report id and the owning kinfolkId
 * (the server uses kinfolkId == familyId to prove the tale belongs to that
 * family). Drafts are not shareable. Kept top-level + pure so it is unit-tested
 * without a live data source.
 */
internal fun shareLinkPreflightError(report: KinCareReport): String? = when {
    report.status != "SENT" ->
        "Send this KinTale first. Only a sent KinTale can be shared."
    report._id.isBlank() ->
        "Cannot share: this KinTale has not been saved yet."
    report.kinfolkId.isBlank() ->
        "Cannot share: this KinTale has no kinfolk to route the link to."
    else -> null
}

/**
 * Groups a flat, chronologically-ordered comment list into a 1-level thread:
 * each top-level comment (parentCommentId == null) followed by its direct replies,
 * in chronological order. Replies whose parent is missing (e.g. a deeper nesting or
 * a deleted parent) are rendered as their own top-level rows rather than dropped.
 */
fun buildCommentThread(comments: List<KinTaleComment>): List<CommentRow> {
    val ordered = comments.sortedBy { it.createdAtMs ?: 0L }
    val topLevel = ordered.filter { it.parentCommentId.isNullOrBlank() }
    val byParent = ordered.filter { !it.parentCommentId.isNullOrBlank() }.groupBy { it.parentCommentId }
    val knownIds = ordered.map { it._id }.toSet()
    val rows = mutableListOf<CommentRow>()
    for (parent in topLevel) {
        rows.add(CommentRow(parent, isReply = false))
        byParent[parent._id]?.forEach { reply -> rows.add(CommentRow(reply, isReply = true)) }
    }
    // Orphan replies (parent not present) surface as top-level rows, never silently dropped.
    for (c in ordered) {
        if (!c.parentCommentId.isNullOrBlank() && c.parentCommentId !in knownIds) {
            rows.add(CommentRow(c, isReply = false))
        }
    }
    return rows
}

/** A flattened comment thread row: the comment plus whether it renders indented as a reply. */
data class CommentRow(val comment: KinTaleComment, val isReply: Boolean)
