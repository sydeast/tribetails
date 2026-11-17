package com.tribetails.auntieos.domain

/**
 * #2357: WHAT THE OWNER READS AFTER "UNDO ARRIVAL".
 *
 * The undo is quiet (#2038): the server sends the household nothing and takes
 * the arrival's notice off their notifications list, from the write this app
 * makes. The toast used to say "The arrival notice is off the household's
 * notifications list" after every undo, including one for a household that was
 * never told. The server now records what each undo took off, at
 * `visit_step_notices/{visit}__undo_arrival__{the undone arrival's stamp}`
 * (`functions/src/lib/arrivalNoticeWithdrawal.ts`), and the toast says an entry
 * came off only when that record names one.
 *
 * Web says the same in `lib/sessionLifecycle.ts#undoArrivalDoneSentence`, and
 * the desktop console in `screens/sessions/UndoArrivalNotice.kt`.
 */

/** The notices one Undo arrival took off the household's notifications list. */
data class UndoneArrivalNotices(val arrived: Boolean, val departed: Boolean)

/** The `event` of the server's record of one Undo arrival. */
const val UNDO_ARRIVAL_RECORD_EVENT = "undo_arrival"

/** True of every undo, whatever was on the household's list. */
const val UNDO_ARRIVAL_SENT_NOTHING = "Arrival undone. No message was sent about the undo."

/** Shown while the server's record of what the undo took off is on its way. */
const val UNDO_ARRIVAL_CHECKING = "$UNDO_ARRIVAL_SENT_NOTHING Checking the household's notifications list."

/** PURE. The record's `withdrawn` list as the two notices this app has words for. */
fun undoneArrivalNoticesOf(withdrawn: List<*>?): UndoneArrivalNotices = UndoneArrivalNotices(
    arrived = withdrawn?.contains("arrived") == true,
    departed = withdrawn?.contains("departed") == true,
)

private val ZONELESS_STAMP = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$""")

/**
 * PURE. A stamped clock time as the server names a record by it
 * (`functions/src/lib/visitStepNotice.ts#stampMs`): an instant as it is, and
 * the desktop console's wall clock with no zone read as UTC. Null when blank
 * or unreadable, never a guess.
 */
fun visitStampMillisOrNull(iso: String?): Long? {
    val raw = iso?.trim().orEmpty()
    if (raw.isEmpty()) return null
    return runCatching {
        if (ZONELESS_STAMP.matches(raw)) {
            java.time.LocalDateTime.parse(raw).toInstant(java.time.ZoneOffset.UTC).toEpochMilli()
        } else {
            java.time.OffsetDateTime.parse(raw).toInstant().toEpochMilli()
        }
    }.getOrNull()
}

/** PURE. The id of the record for the undo of the arrival stamped [arrivedAtIso], or null with no stamp to name it. */
fun undoArrivalRecordId(sessionId: String, arrivedAtIso: String?): String? =
    visitStampMillisOrNull(arrivedAtIso)?.let { "${sessionId}__${UNDO_ARRIVAL_RECORD_EVENT}__$it" }

/**
 * PURE. The toast once the arrival is undone.
 *
 * @param off the server's record, or null when none arrived in time: the
 *   sentence then claims nothing about their list.
 * @param fromDeparted the visit read Departed when it was undone, so there was
 *   a departure the household could have been told about too.
 */
fun undoArrivalDoneSentence(off: UndoneArrivalNotices?, fromDeparted: Boolean): String = when {
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
