package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

/**
 * Admin-side wrapper for the KinTale comment thread (spec 11 item 6.2).
 *
 * - Read: a live snapshot listener on the canonical path
 *   `kin_care_reports/{taleId}/comments`, ordered chronologically. Admins read
 *   directly per the MyTribe Firestore rules (comments read = isAuntie() OR the
 *   matching kinfolk). A listener error surfaces fail-loud as a [CommentsState.Error]
 *   (never a silent emptyList), so the UI can show a banner instead of pretending
 *   the thread is empty.
 * - Write: the `addKinTaleComment` callable. The server forces authorRole='admin'
 *   and requires an explicit kinfolkId for admin callers. parentCommentId carries a
 *   1-level reply. The onKinTaleCommentCreate trigger notifies the kinfolk.
 *
 * The guest compose path (addGuestKinTaleComment, reCAPTCHA + share-token) is
 * MyTribe/kinfolk-only and intentionally absent here: admins author as 'admin'.
 */
class KinTaleCommentsRepository(
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
    firestoreProvider: () -> FirebaseFirestore = { FirebaseFirestore.getInstance() },
) {
    // Lazy so merely constructing the repo (e.g. as a ViewModel default in a
    // Firebase-less Robolectric test) never eagerly touches Firebase singletons.
    private val functions: FirebaseFunctions by lazy(functionsProvider)
    private val firestore: FirebaseFirestore by lazy(firestoreProvider)

    data class KinTaleComment(
        val id: String = "",
        val authorRole: String = "",
        val authorUid: String? = null,
        val guestName: String? = null,
        val body: String = "",
        val parentCommentId: String? = null,
        val createdAtMs: Long? = null,
    )

    /**
     * Fail-loud read state. A listener error is surfaced explicitly rather than
     * collapsed into an empty list, so the screen can banner the failure.
     */
    sealed interface CommentsState {
        data object Loading : CommentsState
        data class Data(val comments: List<KinTaleComment>) : CommentsState
        data class Error(val message: String) : CommentsState
    }

    /** Live thread for a SENT report, oldest first. Emits Loading, then Data / Error. */
    fun streamComments(taleId: String): Flow<CommentsState> = callbackFlow {
        require(taleId.isNotBlank()) { "streamComments requires a non-blank taleId" }
        trySend(CommentsState.Loading)
        val ref = firestore
            .collection("kin_care_reports").document(taleId)
            .collection("comments")
            .orderBy("createdAtMs", Query.Direction.ASCENDING)

        val registration = ref.addSnapshotListener { snap, err ->
            if (err != null) {
                AuntieLog.e("KinTaleCommentsRepository.comments listener error", err)
                trySend(CommentsState.Error(err.message ?: "Could not load comments."))
                return@addSnapshotListener
            }
            val comments = snap?.documents.orEmpty().map { d ->
                KinTaleComment(
                    id = d.id,
                    authorRole = d.getString("authorRole").orEmpty().ifBlank { "kinfolk" },
                    authorUid = d.getString("authorUid"),
                    guestName = d.getString("guestName"),
                    body = d.getString("body").orEmpty(),
                    parentCommentId = d.getString("parentCommentId"),
                    createdAtMs = d.getLong("createdAtMs"),
                )
            }
            trySend(CommentsState.Data(comments))
        }
        awaitClose { registration.remove() }
    }

    /**
     * Post an admin comment (top-level when [parentCommentId] is null, else a reply).
     * Server forces authorRole='admin' and requires kinfolkId. Returns the new
     * comment id. Fail-loud: a blank body is rejected before the call, and any
     * callable failure is logged and returned as Result.failure.
     */
    suspend fun addComment(
        taleId: String,
        kinfolkId: String,
        body: String,
        parentCommentId: String? = null,
    ): Result<String> = runCatching {
        require(taleId.isNotBlank()) { "taleId cannot be blank." }
        require(kinfolkId.isNotBlank()) { "kinfolkId cannot be blank." }
        require(body.isNotBlank()) { "Comment body cannot be blank." }
        AuntieLog.i("KinTaleCommentsRepository: addKinTaleComment kinfolk=$kinfolkId tale=$taleId reply=${parentCommentId != null}")
        val payload = buildMap<String, Any> {
            put("kinfolkId", kinfolkId)
            put("taleId", taleId)
            put("body", body)
            if (!parentCommentId.isNullOrBlank()) put("parentCommentId", parentCommentId)
        }
        @Suppress("UNCHECKED_CAST")
        val raw = functions.getHttpsCallable("addKinTaleComment").call(payload).await().data as? Map<String, Any?>
            ?: error("addKinTaleComment: non-map payload")
        raw["commentId"] as? String ?: error("addKinTaleComment: missing commentId")
    }.onFailure { AuntieLog.e("KinTaleCommentsRepository.addComment failed", it) }

    companion object {
        /**
         * Groups a flat, chronological comment list into a 1-level thread: each
         * top-level comment (parentCommentId null/blank) followed by its direct
         * replies in chronological order. Orphan replies (parent missing, e.g. a
         * deeper nesting or a deleted parent) surface as their own top-level rows
         * rather than being silently dropped. Pure; unit-tested.
         */
        fun buildCommentThread(comments: List<KinTaleComment>): List<CommentRow> {
            val ordered = comments.sortedBy { it.createdAtMs ?: 0L }
            val topLevel = ordered.filter { it.parentCommentId.isNullOrBlank() }
            val byParent = ordered.filter { !it.parentCommentId.isNullOrBlank() }
                .groupBy { it.parentCommentId }
            val knownIds = ordered.map { it.id }.toSet()
            val rows = mutableListOf<CommentRow>()
            for (parent in topLevel) {
                rows.add(CommentRow(parent, isReply = false))
                byParent[parent.id]?.forEach { reply -> rows.add(CommentRow(reply, isReply = true)) }
            }
            for (c in ordered) {
                if (!c.parentCommentId.isNullOrBlank() && c.parentCommentId !in knownIds) {
                    rows.add(CommentRow(c, isReply = false))
                }
            }
            return rows
        }
    }

    /** A flattened thread row: the comment plus whether it renders indented as a reply. */
    data class CommentRow(val comment: KinTaleComment, val isReply: Boolean)
}
