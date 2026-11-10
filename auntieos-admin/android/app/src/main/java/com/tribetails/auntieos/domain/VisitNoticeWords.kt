package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.notifications.VisitNotifier

/**
 * #1794: what the household is told about a visit-clock tap, in plain words,
 * BEFORE the tap (the confirm) and AFTER it (the line the Auntie reads).
 *
 * Found on the Nov 10 walk: the confirm promised the household would be told
 * while the household-notices switch was off and the household had no portal
 * account, the server threw on the missing account, and the screen said
 * "kinfolk notified" anyway. Web carries the same sentences in
 * `auntieos-admin/src/lib/visitNotice.ts`; keep the two word for word.
 *
 * ONE ORDER, SHARED WITH THE SERVER AND WEB: no portal account is named before
 * the switch, because turning the switch on would not reach that household
 * either. The server checks in the same order
 * (`dispatchVisitNotification.ts#VISIT_NOTICE_REASONS`).
 */

/** What one dispatch did, once it settles. Never a reason to fail a tap. */
data class VisitNotifyOutcome(val notified: Boolean, val notifySkipped: String?)

/**
 * The [VisitNotifier] result as an outcome.
 *
 * A failed call is `dispatch_failed`. A suppressed answer with no `reason` comes
 * from a server that predates #1794 and reads `not_sent`, never a guessed cause.
 */
fun visitNotifyOutcomeOf(result: Result<VisitNotifier.DispatchResult>): VisitNotifyOutcome =
    result.fold(
        onSuccess = { r ->
            if (!r.suppressed) VisitNotifyOutcome(notified = true, notifySkipped = null)
            else VisitNotifyOutcome(notified = false, notifySkipped = r.reason?.takeIf { it.isNotBlank() } ?: "not_sent")
        },
        onFailure = { VisitNotifyOutcome(notified = false, notifySkipped = "dispatch_failed") },
    )

/** "the Wrens" opens a sentence as "The Wrens". */
private fun opening(name: String): String = name.replaceFirstChar { it.uppercaseChar() }

/**
 * The sentence shown once the notification has settled, or `""` when there is
 * nothing to say about the household (an undo, or a tap that wrote nothing).
 */
fun visitNoticeOutcomeSentence(outcome: VisitNotifyOutcome, household: String): String {
    val name = opening(household)
    if (outcome.notified) return "$name was notified."
    return when (outcome.notifySkipped) {
        "no_event_for_action", "already_in_this_state" -> ""
        "household_has_no_portal_account" -> "$name was not notified, because they have no portal account."
        "household_notices_off" -> "$name was not notified, because notices to households are off in Settings."
        "household_prefs_suppressed" -> "$name was not notified, because this notice is turned off for them."
        "already_notified" -> "$name was already told about this step, so it was not sent again."
        "session_has_no_kinfolk" -> "No household was notified, because this visit is not linked to one."
        "session_has_no_routing_ids" -> "$name was not notified, because this visit is not linked to a booking."
        "dispatch_failed" -> "The notice to $household could not be sent."
        else -> "$name was not notified."
    }
}

/**
 * The reason a session cannot be routed at all, from the row alone, or null
 * when it can. The same checks [VisitNotifier.notify] makes before it calls.
 */
fun visitRoutingSkip(session: KinCareSession): String? {
    if (session.kinfolkId.isBlank()) return "session_has_no_kinfolk"
    val envelope = !session.kinCareBatchId.isNullOrBlank() && !session.kinCareVisitId.isNullOrBlank()
    if (!envelope && session.sourceBookingId.isBlank()) return "session_has_no_routing_ids"
    return null
}

/** What each event tells the household, as the end of "X will be told ...". */
private fun toldWhat(event: VisitNotifier.Event): String? = when (event) {
    VisitNotifier.Event.ON_MY_WAY -> "their Auntie is on the way"
    VisitNotifier.Event.ARRIVED -> "their Auntie has arrived"
    VisitNotifier.Event.DEPARTED -> "the visit has finished"
    VisitNotifier.Event.REPORT_SENT -> null
}

/**
 * The confirm's line about the household, future tense, or null when it should
 * say nothing (the switch or the household record has not loaded).
 *
 * @param hasPortalAccount whether the household's `kinfolk.uid` is set, which is
 *   what the server routes to. Null while the record has not loaded.
 * @param noticesLive `business_settings.householdNotificationsLive`, null while
 *   the settings read has not landed or failed.
 */
fun visitNoticeConfirmLine(
    event: VisitNotifier.Event,
    session: KinCareSession,
    hasPortalAccount: Boolean?,
    noticesLive: Boolean?,
    household: String,
): String? {
    val what = toldWhat(event) ?: return null
    val name = opening(household)
    when (visitRoutingSkip(session)) {
        "session_has_no_kinfolk" -> return "No household will be told, because this visit is not linked to one."
        "session_has_no_routing_ids" -> return "$name will not be told, because this visit is not linked to a booking."
    }
    if (hasPortalAccount == false) return "$name will not be told, because they have no portal account."
    if (hasPortalAccount == null) return null
    if (noticesLive == false) return "$name will not be told, because notices to households are off in Settings."
    if (noticesLive == null) return null
    return "$name will be told $what."
}
