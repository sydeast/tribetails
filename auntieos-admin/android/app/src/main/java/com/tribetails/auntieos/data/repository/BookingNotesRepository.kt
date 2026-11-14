package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
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
    /** Live snapshot of kinfolk-facing notes for a booking, oldest first. */
    fun streamKinfolkFacingNotes(kinfolkId: String, bookingId: String): Flow<List<BookingNote>> =
        notesStream(kinfolkId, bookingId, subcollection = "notes")

    // #1580: there is no internal-notes stream any more. It listened to
    // `families/{k}/bookings/{bookingId}/internalNotes`, a path the server never
    // writes; the visit's internal notes are read with [listVisitInternalNotes].

    private fun notesStream(
        kinfolkId: String,
        bookingId: String,
        subcollection: String,
    ): Flow<List<BookingNote>> = callbackFlow {
        val ref = firestore
            .collection("families").document(kinfolkId)
            .collection("bookings").document(bookingId)
            .collection(subcollection)
            .orderBy("createdAtMs", Query.Direction.ASCENDING)

        val registration = ref.addSnapshotListener { snap, err ->
            if (err != null) {
                AuntieLog.e("BookingNotesRepository.$subcollection listener error", err)
                trySend(emptyList())
                return@addSnapshotListener
            }
            val notes = snap?.documents.orEmpty().map { d ->
                BookingNote(
                    id = d.id,
                    authorUid = d.getString("authorUid").orEmpty(),
                    authorRole = d.getString("authorRole").orEmpty(),
                    body = d.getString("body").orEmpty(),
                    createdAtMs = d.getLong("createdAtMs"),
                )
            }
            trySend(notes)
        }
        awaitClose { registration.remove() }
    }
}
