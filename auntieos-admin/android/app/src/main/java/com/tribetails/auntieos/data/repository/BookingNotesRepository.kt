package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.contracts.AddBookingNoteArgs
import com.tribetails.auntieos.data.contracts.AddInternalBookingNoteArgs
import com.tribetails.auntieos.data.contracts.decodeAddBookingNoteResult
import com.tribetails.auntieos.data.contracts.decodeAddInternalBookingNoteResult
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

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

    /** Append a kinfolk-facing note. Server returns failed-precondition inside 3hr window. */
    suspend fun addKinfolkFacingNote(
        kinfolkId: String,
        bookingId: String,
        body: String,
    ): Result<String> = runCatching {
        require(body.isNotBlank()) { "Note body cannot be blank." }
        AuntieLog.i("BookingNotesRepository: addBookingNote kinfolk=$kinfolkId booking=$bookingId")
        val args = AddBookingNoteArgs(kinfolkId = kinfolkId, bookingId = bookingId, body = body)
        val raw = functions.getHttpsCallable("addBookingNote").call(args.toPayload()).await().data
        @Suppress("UNCHECKED_CAST")
        decodeAddBookingNoteResult(raw as? Map<String, Any?>).noteId
    }.onFailure { AuntieLog.e("BookingNotesRepository.addKinfolkFacingNote failed", it) }

    /** Append an admin-internal note. Admin-only via callable claim guard. */
    suspend fun addInternalNote(
        kinfolkId: String,
        bookingId: String,
        body: String,
    ): Result<String> = runCatching {
        require(body.isNotBlank()) { "Internal note body cannot be blank." }
        AuntieLog.i("BookingNotesRepository: addInternalBookingNote kinfolk=$kinfolkId booking=$bookingId")
        val args = AddInternalBookingNoteArgs(kinfolkId = kinfolkId, bookingId = bookingId, body = body)
        val raw = functions.getHttpsCallable("addInternalBookingNote").call(args.toPayload()).await().data
        @Suppress("UNCHECKED_CAST")
        decodeAddInternalBookingNoteResult(raw as? Map<String, Any?>).noteId
    }.onFailure { AuntieLog.e("BookingNotesRepository.addInternalNote failed", it) }

    /** Live snapshot of kinfolk-facing notes for a booking, oldest first. */
    fun streamKinfolkFacingNotes(kinfolkId: String, bookingId: String): Flow<List<BookingNote>> =
        notesStream(kinfolkId, bookingId, subcollection = "notes")

    /** Live snapshot of admin-internal notes for a booking, oldest first. */
    fun streamInternalNotes(kinfolkId: String, bookingId: String): Flow<List<BookingNote>> =
        notesStream(kinfolkId, bookingId, subcollection = "internalNotes")

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
