package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.visitStepNoticeId
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * #2357: WHAT THE CONSOLE SAYS AFTER "UNDO ARRIVED".
 *
 * The undo is quiet (#2038): the server sends the household nothing and takes
 * the arrival's notice off their notifications list, from the write this
 * console makes. The toast used to say "The arrival notice is off the
 * household's notifications list" after every undo, including one for a
 * household that was never told. The server now records what each undo took
 * off, at `visit_step_notices/{visit}__undo_arrival__{the undone arrival's
 * stamp}` (`functions/src/lib/arrivalNoticeWithdrawal.ts`), and the toast says
 * an entry came off only when that record names one.
 *
 * Web says the same in `lib/sessionLifecycle.ts#undoArrivalDoneSentence`, and
 * Android in `domain/UndoArrivalNotice.kt`.
 */

/** The notices one Undo arrival took off the household's notifications list. */
internal data class UndoneArrivalNotices(val arrived: Boolean, val departed: Boolean)

/** The `event` of the server's record of one Undo arrival. */
internal const val UNDO_ARRIVAL_RECORD_EVENT = "undo_arrival"

/** True of every undo, whatever was on the household's list. */
internal const val UNDO_ARRIVAL_SENT_NOTHING = "Arrival undone. No message was sent about the undo."

/** Shown while the server's record of what the undo took off is on its way. */
internal const val UNDO_ARRIVAL_CHECKING = "$UNDO_ARRIVAL_SENT_NOTHING Checking the household's notifications list."

/** PURE. Is this patch an Undo arrival: back to Scheduled or On my way, with the arrival cleared? */
internal fun isUndoArrivalPatch(fields: Map<String, String>): Boolean {
    val status = fields["status"]?.trim()?.uppercase()
    return (status == "SCHEDULED" || status == "ON_MY_WAY") && fields["arrivedAt"] == ""
}

/** PURE. The server's record as the two notices this console has words for. */
internal fun undoneArrivalNoticesOf(record: JsonObject): UndoneArrivalNotices {
    val withdrawn = (record["withdrawn"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    return UndoneArrivalNotices(arrived = "arrived" in withdrawn, departed = "departed" in withdrawn)
}

/**
 * PURE. The id of the record for the undo of the arrival stamped
 * [arrivedAtIso], or null with no stamp to name it. The stamp is read as
 * [visitNoticeAtMs] reads it, a zone-less one from an older console included,
 * so the id is the one the server wrote.
 */
internal fun undoArrivalRecordId(sessionId: String, arrivedAtIso: String?): String? {
    val raw = arrivedAtIso?.trim().orEmpty()
    if (raw.isEmpty()) return null
    return visitNoticeAtMs(raw)?.let { visitStepNoticeId(sessionId, UNDO_ARRIVAL_RECORD_EVENT, it) }
}

/**
 * PURE. The toast once the arrival is undone.
 *
 * @param off the server's record, or null when none arrived in time: the
 *   sentence then claims nothing about their list.
 * @param fromDeparted the visit read Departed when it was undone, so there was
 *   a departure the household could have been told about too.
 */
internal fun undoArrivalDoneSentence(off: UndoneArrivalNotices?, fromDeparted: Boolean): String = when {
    off == null -> UNDO_ARRIVAL_SENT_NOTHING
    off.arrived && off.departed ->
        "$UNDO_ARRIVAL_SENT_NOTHING The arrival and departure notices are off the household's notifications list."
    off.arrived ->
        "$UNDO_ARRIVAL_SENT_NOTHING The arrival notice is off the household's notifications list."
    off.departed ->
        "$UNDO_ARRIVAL_SENT_NOTHING The household was not told about the arrival. The departure notice is off their notifications list."
    fromDeparted ->
        "$UNDO_ARRIVAL_SENT_NOTHING The household was not told about the arrival or the departure, so nothing was on their notifications list."
    else ->
        "$UNDO_ARRIVAL_SENT_NOTHING The household was not told about the arrival, so nothing was on their notifications list."
}

/**
 * What one Undo arrival took off the household's notifications list, as the
 * SERVER recorded it. Polls [read] for up to [waitMs]. Null when there is no
 * stamp to name the record or none arrived in time: the toast then claims
 * nothing about their list. The server writes the record only once the
 * arrival's own notice is settled, so "none" means the household was never
 * told.
 */
internal suspend fun awaitUndoneArrivalNotices(
    sessionId: String,
    arrivedAtIso: String?,
    waitMs: Long,
    pollMs: Long = 1_500L,
    read: suspend (String) -> JsonObject?,
): UndoneArrivalNotices? {
    val id = undoArrivalRecordId(sessionId, arrivedAtIso) ?: return null
    var waited = 0L
    while (true) {
        val doc = runCatchingCancellable { read(id) }.getOrNull()
        if (doc != null) return undoneArrivalNoticesOf(doc)
        if (waited >= waitMs) return null
        kotlinx.coroutines.delay(pollMs)
        waited += pollMs
    }
}
