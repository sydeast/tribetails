package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.contracts.AddBookingNoteArgs
import com.tribetails.auntieos.data.contracts.AddInternalBookingNoteArgs
import com.tribetails.auntieos.data.contracts.AddInternalBookingNoteResult
import com.tribetails.auntieos.data.contracts.ListVisitInternalNotesArgs
import com.tribetails.auntieos.data.contracts.ListVisitInternalNotesResult
import com.tribetails.auntieos.data.contracts.decodeListVisitInternalNotesResult
import com.tribetails.auntieos.data.contracts.decodeAddBookingNoteResult
import com.tribetails.auntieos.data.contracts.decodeAddInternalBookingNoteResult
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import com.tribetails.auntieos.util.runCatchingCancellable

/**
 * Admin-side callable wrapper for booking notes living on the MyTribe-canonical
 * path `families/{kinfolkId}/bookings/{bookingId}/{notes|internalNotes}`.
 *
 * - Kinfolk-facing notes: write via `addBookingNote` callable. Server enforces a
 *   3-hour-before-start cutoff. Both admin and kinfolk see these.
 * - Internal notes: write via `addInternalBookingNote` callable. Admin-only. No
 *   cutoff. Hidden from kinfolk by Firestore rules.
 */
class BookingNotesRepository(
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("us-central1"),
    private val firestore: FirebaseFirestore = FirebaseFirestore.getInstance(),
) {

    data class BookingNote(
        val id: String = "",
        val authorUid: String = "",
        val authorRole: String = "",
        val body: String = "",
        val createdAtMs: Long? = null,
    )

    /**
     * Append a kinfolk-facing note. Server returns failed-precondition inside 3hr window.
     * #2027: answers with the decoded result, whose `notice` says what the household is sent.
     */
    suspend fun addKinfolkFacingNote(
        kinfolkId: String,
        bookingId: String,
        body: String,
    ): Result<com.tribetails.auntieos.data.contracts.AddBookingNoteResult> = runCatchingCancellable {
        require(body.isNotBlank()) { "Note body cannot be blank." }
        AuntieLog.i("BookingNotesRepository: addBookingNote kinfolk=$kinfolkId booking=$bookingId")
        val args = AddBookingNoteArgs(kinfolkId = kinfolkId, bookingId = bookingId, body = body)
        val raw = functions.getHttpsCallable("addBookingNote").call(args.toPayload()).awaitCallable().data
        // #2027: the note id, and what the household is sent about it (`notice`).
        @Suppress("UNCHECKED_CAST")
        decodeAddBookingNoteResult(raw as? Map<String, Any?>)
    }.onFailure { AuntieLog.e("BookingNotesRepository.addKinfolkFacingNote failed", it) }

    /** Append an admin-internal note. Admin-only via callable claim guard. */
    suspend fun addInternalNote(
        kinfolkId: String,
        bookingId: String,
        body: String,
    ): Result<String> = runCatchingCancellable {
        require(body.isNotBlank()) { "Internal note body cannot be blank." }
        AuntieLog.i("BookingNotesRepository: addInternalBookingNote kinfolk=$kinfolkId booking=$bookingId")
        val args = AddInternalBookingNoteArgs(kinfolkId = kinfolkId, bookingId = bookingId, body = body)
        val raw = functions.getHttpsCallable("addInternalBookingNote").call(args.toPayload()).awaitCallable().data
        @Suppress("UNCHECKED_CAST")
        decodeAddInternalBookingNoteResult(raw as? Map<String, Any?>).noteId
    }.onFailure { AuntieLog.e("BookingNotesRepository.addInternalNote failed", it) }

    /**
     * #1580: add an internal note to a visit's ONE list, by its session id.
     *
     * Operator ruling, 2026-11-05 docket: two kinds, shared and admin-only; the
     * writer marks each note, and Aunties see only shared ones. [adminOnly]
     * sends `visibility: 'adminOnly'`, which the server stores where rules let
     * only the owner read, and refuses outright from an Auntie.
     *
     * Every Android writer of internal notes goes through this: the session
     * detail, Auntie Time's "Note to Office" and the live-visit "Add Visit
     * Note". They used to append to the session's own `notes` text, a second
     * store the web's Bookings never read.
     */
    suspend fun addVisitInternalNote(
        sessionId: String,
        body: String,
        adminOnly: Boolean = false,
    ): Result<AddInternalBookingNoteResult> = runCatchingCancellable {
        require(body.isNotBlank()) { "Internal note body cannot be blank." }
        val args = AddInternalBookingNoteArgs(
            sessionId = sessionId,
            body = body.trim(),
            visibility = if (adminOnly) "adminOnly" else "shared",
        )
        val raw = functions.getHttpsCallable("addInternalBookingNote").call(args.toPayload()).awaitCallable().data
        @Suppress("UNCHECKED_CAST")
        decodeAddInternalBookingNoteResult(raw as? Map<String, Any?>)
    }.onFailure { AuntieLog.e("BookingNotesRepository.addVisitInternalNote failed", it) }
    /**
     * #1580: the visit's one list of internal notes, as the signed-in staff
     * member may see it. The server filters on her claim (an Auntie never
     * receives an admin-only note) and says whether to offer the mark.
     */
    suspend fun listVisitInternalNotes(sessionId: String): Result<ListVisitInternalNotesResult> = runCatchingCancellable {
        val args = ListVisitInternalNotesArgs(sessionId = sessionId)
        val raw = functions.getHttpsCallable("listVisitInternalNotes").call(args.toPayload()).awaitCallable().data
        @Suppress("UNCHECKED_CAST")
        decodeListVisitInternalNotesResult(raw as? Map<String, Any?>)
    }.onFailure { AuntieLog.e("BookingNotesRepository.listVisitInternalNotes failed", it) }

    /**
     * #2227: the visit's kinfolk-facing notes, live, oldest first: the shared
     * `notes` thread at `families/{k}/bookings/{batchId}/kinCares/{visitId}/notes`
     * (where `addBookingNote` writes, both the household's rows and the
     * office's) plus the notes the office wrote on Accept or Decline, which
     * live on the visit document itself. The same list admin web's Bookings
     * sheet draws (`answerNoteEntries` + the thread).
     *
     * It used to listen to `families/{k}/bookings/{visitId}/notes` ordered by
     * `createdAtMs`, a path and a field the server never writes, so the panel
     * always read "No kinfolk-facing notes yet." Same dead-path shape #1580
     * fixed for internal notes.
     *
     * No `orderBy`: a row whose `createdAt` is missing or still text would drop
     * out of an ordered query, so the thread is read whole (bounded) and sorted
     * here. A failed thread read emits a failure and ends the flow, because
     * Firestore detaches a listener after its error: the caller re-subscribes
     * on Try again. A failed visit-document read only leaves the two answer
     * notes out, the way web does.
     */
    fun streamVisitKinfolkNotes(
        kinfolkId: String,
        batchId: String,
        visitId: String,
    ): Flow<Result<List<BookingNote>>> = callbackFlow {
        val visitRef = firestore
            .collection("families").document(kinfolkId)
            .collection("bookings").document(batchId)
            .collection("kinCares").document(visitId)
        var thread: List<BookingNote>? = null
        var answers: List<BookingNote> = emptyList()
        fun publish() {
            val t = thread ?: return
            trySend(Result.success(sortKinfolkNotes(answers + t)))
        }
        val threadReg = visitRef.collection("notes").limit(MAX_THREAD_NOTES).addSnapshotListener { snap, err ->
            if (err != null) {
                AuntieLog.e("BookingNotesRepository.streamVisitKinfolkNotes thread error", err)
                trySend(Result.failure(err))
                close()
                return@addSnapshotListener
            }
            thread = snap?.documents.orEmpty().map { d ->
                BookingNote(
                    id = d.id,
                    authorUid = d.getString("authorUid").orEmpty(),
                    authorRole = d.getString("authorRole").orEmpty(),
                    body = d.getString("body").orEmpty(),
                    createdAtMs = noteMillis(
                        d.get("createdAt", com.google.firebase.firestore.DocumentSnapshot.ServerTimestampBehavior.ESTIMATE),
                    ),
                )
            }
            publish()
        }
        val visitReg = visitRef.addSnapshotListener { snap, err ->
            answers = if (err != null) {
                AuntieLog.e("BookingNotesRepository.streamVisitKinfolkNotes visit error", err)
                emptyList()
            } else {
                answerNotesFromVisit(snap?.data)
            }
            publish()
        }
        awaitClose {
            threadReg.remove()
            visitReg.remove()
        }
    }

    // #1580: there is no internal-notes stream any more. It listened to
    // `families/{k}/bookings/{bookingId}/internalNotes`, a path the server never
    // writes; the visit's internal notes are read with [listVisitInternalNotes].

    private companion object {
        /** A visit's thread is a handful of lines; the cap keeps the listener bounded. */
        const val MAX_THREAD_NOTES = 200L
    }
}

/**
 * #2227: epoch millis of a note's `createdAt`, whichever shape it arrived in:
 * a Timestamp on a settled row, ISO text on an older one, null while the
 * server stamp is in flight or when nothing readable is there.
 */
internal fun noteMillis(raw: Any?): Long? = when (raw) {
    null -> null
    is com.google.firebase.Timestamp -> raw.toDate().time
    is java.util.Date -> raw.time
    is Number -> raw.toLong()
    is String -> runCatching { java.time.Instant.parse(raw).toEpochMilli() }
        .recoverCatching { java.time.OffsetDateTime.parse(raw).toInstant().toEpochMilli() }
        .getOrNull()
    else -> null
}

/**
 * #2227: the two notes the office wrote the household on the request itself,
 * as `manageBookingSeries` stamps them on the visit document. Blank ones are
 * left out. Mirrors admin web's `answerNoteEntries`.
 */
internal fun answerNotesFromVisit(visit: Map<String, Any?>?): List<BookingNotesRepository.BookingNote> {
    if (visit == null) return emptyList()
    fun one(id: String, bodyKey: String, atKey: String, byKey: String): BookingNotesRepository.BookingNote? {
        val body = (visit[bodyKey] as? String)?.trim().orEmpty()
        if (body.isEmpty()) return null
        return BookingNotesRepository.BookingNote(
            id = id,
            authorUid = (visit[byKey] as? String).orEmpty(),
            authorRole = "admin",
            body = body,
            createdAtMs = noteMillis(visit[atKey]),
        )
    }
    return listOfNotNull(
        one("request-accepted", "requestAcceptNote", "requestAcceptedAt", "requestAcceptedBy"),
        one("request-declined", "requestDeclineNote", "requestDeclinedAt", "requestDeclinedBy"),
    )
}

/** Oldest first; a note with no readable time sorts to the top rather than being dropped. */
internal fun sortKinfolkNotes(notes: List<BookingNotesRepository.BookingNote>): List<BookingNotesRepository.BookingNote> =
    notes.sortedBy { it.createdAtMs ?: 0L }
