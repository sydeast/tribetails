package com.tribetails.auntieos.domain

import java.time.Instant

/**
 * #2250, operator ruling 2026-11-14: "A short Undo departed. For a few minutes
 * after Departed, Undo departed puts the visit back to Arrived; the household
 * is not told."
 *
 * A departure completes the visit on the server (#2123) and the rules refuse
 * every client the move back, so the undo is the `setVisitLifecycle` callable's
 * `UNDO_DEPARTED` action (`KinCareRepository.undoDeparted`). It needs a
 * connection.
 *
 * NO NUMBER LIVES HERE. How long "a few minutes" is belongs to the server
 * (`functions/src/lib/visitLifecycle.ts`, `UNDO_DEPARTED_WINDOW_MS`). The
 * departure trigger stamps the moment the undo closes on the visit as
 * `undoDepartedUntil`, and this file only compares that moment with now.
 */

/** When this visit's undo closes, in epoch ms, or null when the server opened none. */
fun undoDepartedUntilMs(raw: String?): Long? {
    val iso = raw?.trim().orEmpty()
    if (iso.isEmpty()) return null
    return runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
}

/** Is "Undo departed" offered on a visit with this status and stamp at [nowMs]? */
fun undoDepartedOpen(status: String?, undoDepartedUntil: String?, nowMs: Long): Boolean {
    val s = status?.trim()?.uppercase().orEmpty()
    if (s != "DEPARTED" && s != "COMPLETED") return false
    val until = undoDepartedUntilMs(undoDepartedUntil) ?: return false
    return nowMs <= until
}

const val UNDO_DEPARTED_LABEL = "Undo departed"
const val UNDO_DEPARTED_CONFIRM_TITLE = "Undo departed?"
const val UNDO_DEPARTED_CONFIRM_YES = "Yes, undo departed"
const val UNDO_DEPARTED_WAITING = "Putting the visit back to Arrived…"
const val UNDO_DEPARTED_NO_ANSWER = "Check your connection and try again."

/** What the confirm says will happen. */
fun undoDepartedConfirmBody(household: String): String {
    val whose = household.trim().let { if (it.isEmpty()) "This visit" else "$it’s visit" }
    return "$whose will go back to Arrived, with the arrival time it already has. The household is not told."
}

/**
 * The sentence under the button when the undo did not happen. [serverSentence]
 * is the server's refusal, already plain words (the time has passed, no arrival
 * on record); null or blank is a call that never got an answer.
 */
fun undoDepartedFailureWords(serverSentence: String?): String {
    val reason = serverSentence?.trim().orEmpty().ifEmpty { UNDO_DEPARTED_NO_ANSWER }
    return "Couldn’t undo the departure. $reason"
}
