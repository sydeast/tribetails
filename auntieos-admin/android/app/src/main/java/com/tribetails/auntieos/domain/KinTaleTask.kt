package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.KinCareSession

/**
 * #2123 (operator ruling 2026-11-12): a visit is Completed at departure, and a
 * KinTale never decides that. "KinTale required" is an optional business setting
 * that turns an unsent KinTale into a task the Auntie carries until it is sent.
 * Because an Admin can work as an Auntie, the task never blocks completion.
 *
 * WHO DECIDES WHAT. The server completes the visit at departure
 * (`functions/src/triggers/onKinCareSessionDeparted.ts`) and, when the setting is
 * on and no KinTale has been sent, stamps `kinTaleDue: true` on the session at
 * that moment. Every client's send batch writes `kinTaleDue: false`
 * ([com.tribetails.auntieos.data.repository.KinCareRepository.markReportSent]).
 * So a visit completed before the setting was turned on never becomes a task,
 * and turning the setting off hides every task without rewriting a visit.
 *
 * The web admin's Auntie Time board and the desktop console carry the same
 * rule. Change them together.
 */

/**
 * Is "KinTale required" on, for this raw settings value? The model reads the
 * same way ([com.tribetails.auntieos.data.model.BusinessSettings.kinTaleRequired]
 * defaults to false, and `toObject` fills an absent key from it). ABSENT MEANS
 * OFF (operator ruling 2026-11-13, "Start it off"): only an explicit `true`
 * turns it on, as on the server.
 */
fun kinTaleRequiredSetting(raw: Any?): Boolean = raw == true

/**
 * Has a KinTale for this visit gone to the household? `sentReportCount` alone:
 * every client's send batch bumps it in the same commit that flips the report to
 * SENT. `reportIds` is NOT a sent signal here: this app appends a report's id
 * when the DRAFT is created (`KinCareRepository.createKinCareReport`), so a visit
 * with an unsent draft carries one.
 */
fun kinTaleSent(session: KinCareSession): Boolean = session.sentReportCount > 0

/**
 * Does the Auntie owe this visit's KinTale? Setting on, the visit Completed, the
 * server marked it due at completion, and nothing sent since.
 */
fun kinTaleOwed(session: KinCareSession, required: Boolean): Boolean =
    required &&
        session.status.trim().uppercase() == "COMPLETED" &&
        session.kinTaleDue &&
        !kinTaleSent(session)

/**
 * Does a card offer "Send the KinTale"? On a finished visit (Departed, or the
 * Completed it becomes) whose KinTale has not been sent, whether or not the
 * setting requires one. The write-up used to hang off the Departed card alone;
 * Departed is now a moment, so the offer follows the visit to Completed.
 */
fun offersSendKinTale(session: KinCareSession): Boolean =
    session.status.trim().uppercase() in setOf("DEPARTED", "COMPLETED") && !kinTaleSent(session)

/** The board's "KinTales to send" group and everything else, with no visit in both. */
data class KinTaleSplit(
    val toSend: List<KinCareSession>,
    val rest: List<KinCareSession>,
)

/**
 * Splits the board's visits. [required] is null until the setting is read (or
 * when the read failed): the board then shows no group, rather than guess.
 * The group reads oldest first: the longest-owed KinTale is the one to send next.
 */
fun splitKinTalesToSend(sessions: List<KinCareSession>, required: Boolean?): KinTaleSplit {
    if (required != true) return KinTaleSplit(emptyList(), sessions)
    val (toSend, rest) = sessions.partition { kinTaleOwed(it, required = true) }
    return KinTaleSplit(toSend.sortedBy { it.startTime }, rest)
}

/** The group's heading on the Auntie Time board, word for word the web board's. */
const val KIN_TALES_TO_SEND_LABEL = "KinTales to send"

/** The card button that opens the composer for a finished visit. */
const val SEND_THE_KINTALE_LABEL = "Send the KinTale"
