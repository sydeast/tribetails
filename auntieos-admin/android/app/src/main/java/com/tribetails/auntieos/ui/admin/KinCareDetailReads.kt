package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.ReportStatus
import com.tribetails.auntieos.data.repository.BookingNotesRepository
import com.tribetails.auntieos.data.repository.StaffMember
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * #2265, #2227: the two reads on the KinCare detail that used to fail without a
 * word. Each one now ends in an answer the screen can draw: the list, or a
 * plain "could not load" with Try again. A read that never answers counts as a
 * failure after [VISIT_READ_TIMEOUT_MS], so the panel never waits for good.
 */
internal const val VISIT_READ_TIMEOUT_MS = 20_000L

internal const val VISIT_TALES_FAILED = "Could not load this visit's KinTales."
internal const val KINFOLK_NOTES_FAILED = "Could not load the kinfolk-facing notes."
internal const val KINFOLK_NOTES_NO_RECORD =
    "This visit is not part of a booking request, so it has no kinfolk-facing notes to show."

/** #2265: the "KinTales sent" panel's read. */
internal sealed interface VisitTalesState {
    data object Loading : VisitTalesState
    data object Failed : VisitTalesState
    data class Ready(val tales: List<KinCareReport>) : VisitTalesState
}

/**
 * #2265: read the visit's KinTales and keep the sent ones, newest first.
 *
 * [read] is `KinCareRepository.getReportsForVisit`, the equality-only read the
 * composer has used since PR #2261. The screen used `getReportsForSession`,
 * whose `orderBy("createdAt")` needs a `kin_care_reports` (sessionId,
 * createdAt) index that is declared nowhere, so Firestore refused it and the
 * screen, keeping only a success, said no KinTales were sent.
 *
 * SENT only, the way admin web's visit detail lists `reportIds`: the panel is
 * "KinTales sent", and a draft has not reached the household.
 */
internal suspend fun loadVisitTales(
    read: suspend () -> Result<List<KinCareReport>>,
    timeoutMs: Long = VISIT_READ_TIMEOUT_MS,
): VisitTalesState {
    val answer = withTimeoutOrNull(timeoutMs) { read() } ?: return VisitTalesState.Failed
    return answer.fold(
        onSuccess = { list ->
            VisitTalesState.Ready(
                list.filter { it.status.equals(ReportStatus.SENT.name, ignoreCase = true) }
                    // #1599: by parsed date, newest first.
                    .sortedWith(kinTaleDateComparator(true) { r -> kinTaleSortMillis(r.sentAt.orEmpty().ifBlank { r.createdAt }) }),
            )
        },
        onFailure = { VisitTalesState.Failed },
    )
}

/** #2227: the "Kinfolk-facing note" panel's list. */
internal sealed interface KinfolkNotesState {
    data object Loading : KinfolkNotesState
    /** The visit has no booking-request ids, so there is no thread to read. */
    data object NoRecord : KinfolkNotesState
    data object Failed : KinfolkNotesState
    data class Ready(val notes: List<BookingNotesRepository.BookingNote>) : KinfolkNotesState
}

/**
 * #2227: a live notes stream as panel states. Loading first; then each answer.
 * A failed read ends it on [KinfolkNotesState.Failed] (the caller re-subscribes
 * on Try again), and so does a stream with no first answer inside [firstAnswerMs].
 */
internal fun kinfolkNotesStates(
    source: Flow<Result<List<BookingNotesRepository.BookingNote>>>,
    firstAnswerMs: Long = VISIT_READ_TIMEOUT_MS,
): Flow<KinfolkNotesState> = channelFlow {
    send(KinfolkNotesState.Loading)
    val answered = CompletableDeferred<Unit>()
    val reader = launch {
        source.collect { r ->
            answered.complete(Unit)
            val failed = r.isFailure
            send(r.fold({ KinfolkNotesState.Ready(it) }, { KinfolkNotesState.Failed }))
            if (failed) this@channelFlow.close()
        }
    }
    if (withTimeoutOrNull(firstAnswerMs) { answered.await() } == null) {
        reader.cancel()
        send(KinfolkNotesState.Failed)
        close()
    }
}

/**
 * #2227: who wrote a kinfolk-facing note, in words. `authorRole: 'admin'` is
 * stamped for every staff writer, so the staff member is named from the roster
 * when it is known (never an email), else "Staff". Mirrors admin web's
 * `noteAuthorLabel` and the console's `bookingNoteAuthorLabel`.
 */
internal fun kinfolkNoteAuthorLabel(
    note: BookingNotesRepository.BookingNote,
    staff: List<StaffMember>,
): String = when (note.authorRole.trim().lowercase()) {
    "admin", "auntie", "staff" -> staff.firstOrNull { note.authorUid.isNotBlank() && it.uid == note.authorUid }
        ?.displayName?.trim()?.takeIf { it.isNotEmpty() && !it.contains('@') }
        ?: "Staff"
    "kinfolk" -> "Kinfolk"
    else -> "Unknown"
}
