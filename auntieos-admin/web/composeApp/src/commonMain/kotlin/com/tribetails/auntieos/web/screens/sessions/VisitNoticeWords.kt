package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlin.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * #1840: what the household is told about a visit-clock tap on the desktop
 * console, in plain words, read off the server's own answer.
 *
 * The desktop clock buttons used to patch the visit and toast "On the way."
 * with no call to the server at all, so the household was told nothing and the
 * console said nothing about it. The buttons now dispatch the same notice web
 * and Android do, and the toast carries what the dispatch answered: told, or
 * not told and why (no portal sign-in, household notices switched off, and the
 * rest).
 *
 * There is no confirm on this screen, so nothing here promises a notice before
 * the tap. The sentences are web's `lib/visitNotice.ts` and Android's
 * `domain/VisitNoticeWords.kt`, word for word.
 */

/** What one dispatch did, once it settles. Never a reason to fail a tap. */
internal data class VisitNotifyOutcome(val notified: Boolean, val notifySkipped: String?)

/** One clock step that tells the household: the callable's `event`, and when it was stamped. */
internal data class VisitNoticeEvent(val wire: String, val atIso: String)

/**
 * The household notice a clock patch calls for, or null when it calls for none.
 *
 * Read off the patch itself: a step forward carries its own stamp
 * (`onMyWayAt`, `arrivedAt`, `departedAt`). Undo Arrived also writes
 * `status = ON_MY_WAY`, with no stamp and a cleared `arrivedAt`, and tells
 * nobody.
 */
internal fun visitNoticeEventOf(fields: Map<String, String>): VisitNoticeEvent? {
    fun stamped(wire: String, key: String) =
        fields[key]?.takeIf { it.isNotBlank() }?.let { VisitNoticeEvent(wire, it) }
    return when (fields["status"]) {
        "ON_MY_WAY" -> stamped("on_my_way", "onMyWayAt")
        "ARRIVED"   -> stamped("arrived", "arrivedAt")
        "DEPARTED"  -> stamped("departed", "departedAt")
        else        -> null
    }
}

/** Why this visit cannot be routed to a household at all, or null when it can. */
internal fun visitRoutingSkip(session: KinCareSession): String? {
    if (session.kinfolkId.isBlank()) return "session_has_no_kinfolk"
    val envelope = !session.kinCareBatchId.isNullOrBlank() && !session.kinCareVisitId.isNullOrBlank()
    if (!envelope && session.sourceBookingId.isBlank()) return "session_has_no_routing_ids"
    return null
}

private val noticeJson = Json { ignoreUnknownKeys = true }

/**
 * The `dispatchVisitNotification` answer as an outcome.
 *
 * A failed call is `dispatch_failed`. A suppressed answer with no `reason`
 * (a server from before #1794) reads `not_sent`, never a guessed cause.
 */
internal fun visitNotifyOutcomeOf(result: WriteResult<String>): VisitNotifyOutcome = when (result) {
    is WriteResult.Err -> VisitNotifyOutcome(notified = false, notifySkipped = "dispatch_failed")
    is WriteResult.Ok  -> {
        val body = runCatchingCancellable { noticeJson.parseToJsonElement(result.value) as? JsonObject }.getOrNull()
        if (body == null) {
            VisitNotifyOutcome(notified = false, notifySkipped = "dispatch_failed")
        } else {
            val ids = (body["dispatchIds"] as? JsonArray)?.size ?: 0
            val suppressed = (body["suppressed"] as? JsonPrimitive)?.booleanOrNull ?: (ids == 0)
            if (!suppressed) {
                VisitNotifyOutcome(notified = true, notifySkipped = null)
            } else {
                val reason = (body["reason"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
                VisitNotifyOutcome(notified = false, notifySkipped = reason ?: "not_sent")
            }
        }
    }
}

/** The stamp as epoch milliseconds, or null when it does not parse. */
@OptIn(kotlin.time.ExperimentalTime::class)
internal fun visitNoticeAtMs(atIso: String): Long? =
    runCatchingCancellable { Instant.parse(atIso).toEpochMilliseconds() }.getOrNull()

/**
 * What the household was told about one clock step: named from the row when
 * the visit cannot be routed to a household at all (no call is made), else the
 * answer [dispatch] brings back.
 */
internal suspend fun clockNoticeOutcome(
    session: KinCareSession,
    notice: VisitNoticeEvent,
    dispatch: suspend (event: String, eventAtMs: Long?) -> WriteResult<String>,
): VisitNotifyOutcome {
    visitRoutingSkip(session)?.let { return VisitNotifyOutcome(notified = false, notifySkipped = it) }
    return visitNotifyOutcomeOf(dispatch(notice.wire, visitNoticeAtMs(notice.atIso)))
}

/** "the Wrens" opens a sentence as "The Wrens". */
private fun opening(name: String): String = name.replaceFirstChar { it.uppercaseChar() }

/**
 * The sentence shown once the notification has settled, or `""` when there is
 * nothing to say about the household.
 */
internal fun visitNoticeOutcomeSentence(outcome: VisitNotifyOutcome, household: String): String {
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
        // #2037: the server sends from the saved step; the console only stopped waiting.
        "notice_pending" -> if (household.isBlank()) "Still checking who was told." else "Still checking whether $household was told."
        else -> "$name was not notified."
    }
}

/** The household's name as the sentences use it. */
internal fun visitNoticeHousehold(session: KinCareSession): String =
    session.kinfolkName.trim().ifBlank { "the household" }
