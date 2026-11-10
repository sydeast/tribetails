package com.tribetails.auntieos.web.data

import kotlin.coroutines.cancellation.CancellationException

/**
 * ISSUE #1799: the desktop console's half of "a DEPARTED visit whose KinTale has
 * been sent is marked Completed".
 *
 * Every client's send batch sets `autoCompleteEligible` on the session in the
 * same commit as `sentReportCount` (this console's `markKinTaleReportSent`,
 * Android's `KinCareRepository.kt`, admin web's `api/kinTalesWrite.ts#sendKinTale`).
 * Android completes on it in `HomeViewModel.kt`'s load sweep and offers Complete
 * in `HomeScreen.kt`; admin web does it after the send (#1793,
 * `lib/sessionLifecycle.ts#completesAfterKinTale`). Before this, nothing on the
 * console read the flag, so a written-up visit stayed DEPARTED until someone
 * used the kebab's Mark Completed.
 */

/** The two session fields [completesAfterKinTale] reads, as they come off the document. */
data class SessionCompletionFields(
    val status: String,
    val autoCompleteEligible: Boolean,
)

/**
 * Android's rule, copied as is: `status == DEPARTED && autoCompleteEligible`.
 *
 * DEPARTED ONLY, although the server accepts COMPLETE from SCHEDULED, ON_MY_WAY
 * and ARRIVED too. A tale sent while the Auntie is still in the house sets the
 * flag as well, and completing then would close a visit she has not clocked out
 * of. It becomes ready when she departs. Reading `sentReportCount` as well would
 * let this console complete a visit Android leaves open, so it does not.
 */
fun completesAfterKinTale(status: String, autoCompleteEligible: Boolean): Boolean =
    status.trim().uppercase() == "DEPARTED" && autoCompleteEligible

fun completesAfterKinTale(session: KinCareSession): Boolean =
    completesAfterKinTale(session.status, session.autoCompleteEligible)

/** What [FirestoreClient.completeVisitAfterKinTale] did. It never throws; this says why. */
sealed interface VisitCompletionAfterSend {
    /** The visit is now COMPLETED. */
    data object Completed : VisitCompletionAfterSend

    /** Not DEPARTED, or not flagged, so nothing was asked of the server. */
    data class LeftOpen(val status: String) : VisitCompletionAfterSend

    /** It was ready, and the read or the server refused. [message] is the reason. */
    data class NotCompleted(val message: String) : VisitCompletionAfterSend
}

/**
 * Read the session fresh, and complete it through `transitionBookingStatus`
 * when the rule holds.
 *
 * FRESH, after the send has committed, rather than trusting the row the screen
 * was holding: the server accepts COMPLETE from the pre-DEPARTED states too, so
 * acting on a stale "it departed" could complete a visit the Auntie is still
 * inside. The read also sees the flag the send just set.
 *
 * THE CALLABLE, never a status write. `firestore.rules`
 * (`bookingTerminalFieldsUntouched`) refuses a client write of COMPLETED or
 * `completedAt`, and the callable runs the operator's arrival rule and the audit.
 *
 * NEVER THROWS (cancellation aside). The KinTale has already gone home when this
 * runs, and a refusal read as "couldn't send" would invite a second send, which
 * bumps `sentReportCount` again. Every failure comes back as [VisitCompletionAfterSend.NotCompleted].
 */
internal suspend fun runVisitCompletionAfterKinTale(
    sessionId: String,
    read: suspend (String) -> SessionCompletionFields?,
    complete: suspend (sessionId: String, completedAt: String) -> WriteResult<Unit>,
    now: () -> String,
): VisitCompletionAfterSend = try {
    val fields = read(sessionId)
    val status = fields?.status.orEmpty()
    if (fields == null || !completesAfterKinTale(fields.status, fields.autoCompleteEligible)) {
        VisitCompletionAfterSend.LeftOpen(status)
    } else {
        when (val r = complete(sessionId, now())) {
            is WriteResult.Ok -> VisitCompletionAfterSend.Completed
            is WriteResult.Err -> VisitCompletionAfterSend.NotCompleted(r.message.ifBlank { "Unknown error." })
        }
    }
} catch (c: CancellationException) {
    throw c
} catch (t: Throwable) {
    VisitCompletionAfterSend.NotCompleted(t.message?.takeIf { it.isNotBlank() } ?: "Unknown error.")
}

/** The confirmation after a send that went through. Same sentences as admin web (#1793). */
fun kinTaleSentMessage(completion: VisitCompletionAfterSend): String = when (completion) {
    VisitCompletionAfterSend.Completed -> "KinTale sent and the visit is marked Completed. Kinfolk will hear from you soon."
    is VisitCompletionAfterSend.LeftOpen -> "KinTale sent. Kinfolk will hear from you soon."
    is VisitCompletionAfterSend.NotCompleted -> sentButNotCompletedNotice(completion.message)
}

/**
 * What the console says when the tale went home but the visit could not be
 * marked Completed. The server's reason is its own sentence whatever shape it
 * arrives in ("Not signed in" from a failed read has no full stop). Same words
 * as admin web's `sentButNotCompletedNotice`.
 */
fun sentButNotCompletedNotice(reason: String): String {
    val trimmed = reason.trim()
    val sentence = when {
        trimmed.isEmpty() -> ""
        trimmed.last() in ".!?" -> "$trimmed "
        else -> "$trimmed. "
    }
    return "KinTale sent. Kinfolk will hear from you soon. The visit could not be marked Completed. " +
        "${sentence}You can mark it Completed from Auntie Time."
}
