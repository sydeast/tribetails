package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.MessageDraftStanding
import com.tribetails.auntieos.web.data.WriteResult
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * #2428: a Communicate draft that already went out, and the one send of an
 * Email or Text draft.
 *
 * The console opened every stored draft as "needs approval", with Approve and
 * send and Delete draft, unless it was a sent KinTale or a held Push. A Push
 * the household already had, and an Email or Text that had already gone, opened
 * the same way as a draft nobody had touched, and approving the Email or Text
 * again sent it again. Nothing on the draft said it had gone: the console
 * approved it with its own write and then called `sendExternalMessage`, which
 * has never heard of the draft. An Email or Text approve did not even switch
 * its own button off, so a second click in the same sitting sent a second copy.
 *
 * Now the `sendGeneratedDraft` callable approves, sends and stamps the draft in
 * one call, and a stored draft is read for what it carries
 * ([GeneratedDraft.isSentPush], [GeneratedDraft.sentMessageChannel]). Same
 * rules and the same sentences as the web admin's `lib/draftSent.ts` and the
 * phone's `DraftSent.kt`.
 *
 * #2452: a send that got no answer is told apart from one that went
 * ([GeneratedDraft.messageStanding]) and has its own notice, on open and in the
 * sitting where it happened. On the console that answer was a toast, so it was
 * gone in a few seconds and the screen went back to looking like a draft
 * nobody had approved. It is held on the screen now ([DraftSendOutcome.Unconfirmed]).
 */

/** What `sendGeneratedDraft` answered. */
internal data class DraftSendResult(
    /** `sent`: this call sent it. `already_sent`: it went out before, or may have; nothing new was sent. */
    val outcome: String,
    /** Masked address the message went to. Blank when an older version sent it. */
    val recipientRedacted: String,
)

internal const val DRAFT_SENT = "sent"
internal const val DRAFT_ALREADY_SENT = "already_sent"

/**
 * Pure: the callable's answer. Only the literal word claims a send. Any other
 * answer means the call was taken and this draft will not go out again, which
 * is what `already_sent` says.
 */
internal fun decodeDraftSendResult(raw: String?): DraftSendResult {
    val obj = runCatching { Json.parseToJsonElement(raw.orEmpty()).jsonObject }.getOrNull()
    fun text(key: String): String =
        obj?.get(key)?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }.orEmpty()
    return DraftSendResult(
        outcome = if (text("outcome") == DRAFT_SENT) DRAFT_SENT else DRAFT_ALREADY_SENT,
        recipientRedacted = text("recipientRedacted"),
    )
}

/**
 * What the screen shows in place of Approve for an Email or Text that is past
 * approving. [confirmed] is false when the notice does not vouch for a send
 * (#2452): the send got no answer, or is still running.
 */
internal data class SentDraftNotice(val title: String, val body: String, val confirmed: Boolean = true)

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Nov 20, 2026" in [zone], or blank when the stamp is missing or unreadable. */
@OptIn(ExperimentalTime::class)
internal fun sentDayOf(iso: String?, zone: TimeZone): String {
    if (iso.isNullOrBlank()) return ""
    val at = runCatching { Instant.parse(iso.trim()).toLocalDateTime(zone) }.getOrNull() ?: return ""
    return "${MONTHS[at.monthNumber - 1]} ${at.dayOfMonth}, ${at.year}"
}

/**
 * Pure: the notice for an opened Email or Text draft that already went out, or
 * null for any other draft. A stamped one says who, how and when. An approved
 * one with no stamp says it was approved, never that a delivery was recorded.
 */
internal fun sentDraftNotice(
    draft: GeneratedDraft,
    household: String,
    zone: TimeZone,
    nowMs: Long = draftClockMs(),
): SentDraftNotice? {
    val channel = draft.sentMessageChannel ?: return null
    val who = household.trim().ifBlank { "the household" }
    val how = if (channel == "email") "email" else "text"
    return when (draft.messageStanding(nowMs)) {
        null -> null
        MessageDraftStanding.Sent -> {
            val day = sentDayOf(draft.sentAt, zone)
            SentDraftNotice("Already sent", "Sent to $who by $how${if (day.isNotBlank()) " on $day" else ""}. It is not sent again.")
        }
        // #2452: the send got no answer. It read "Already approved", which
        // says sent about a send nobody can vouch for.
        MessageDraftStanding.Unconfirmed ->
            unconfirmedSendNotice(household, channel, sentDayOf(draft.sendUnconfirmedAt.ifBlank { draft.sendClaimedAt }, zone))
        MessageDraftStanding.Sending -> SentDraftNotice(
            "Being sent",
            "This $how for $who is being sent right now. Open it again in a few minutes to see what happened.",
            confirmed = false,
        )
        // Approved with no stamp and no claim: an older version approved and sent it.
        MessageDraftStanding.Approved -> {
            val day = sentDayOf(draft.approvedAt, zone)
            SentDraftNotice(
                "Already approved",
                "This $how for $who was approved${if (day.isNotBlank()) " on $day" else ""}. Approving sends it, so it is not sent again.",
            )
        }
    }
}

/**
 * #2452: the notice for an Email or Text whose send got no answer. The same
 * words whether the draft was opened that way or the server just said so.
 * [channel] is `email` or `sms`; [day] is blank when there is no stamp to read.
 */
internal fun unconfirmedSendNotice(household: String?, channel: String?, day: String = ""): SentDraftNotice {
    val how = when (channel) {
        "email" -> "email"
        "sms" -> "text"
        else -> "message"
    }
    val who = household?.trim()?.ifBlank { null } ?: "the household"
    return SentDraftNotice(
        "Send not confirmed",
        "The send of this $how to $who${if (day.isNotBlank()) " on $day" else ""} did not get an answer, " +
            "so it is not known whether it reached them. It is not sent again from this draft. " +
            "Write a new one if it has to go again.",
        confirmed = false,
    )
}

/** The clock a draft's claim is read against. Its own function so the screens need no opt-in of their own. */
@OptIn(ExperimentalTime::class)
internal fun draftClockMs(): Long = kotlin.time.Clock.System.now().toEpochMilliseconds()

/** #2452: the `details.code` of the refusal `sendGeneratedDraft` gives when a send got no answer. */
internal const val DRAFT_SEND_UNCONFIRMED_CODE = "draft_send_unconfirmed"

/**
 * Pure: the words on the Approve button. It is off for every answer but the
 * last two. "Sent" is said only for a send somebody vouches for.
 */
internal fun approveButtonLabel(sent: Boolean, notice: SentDraftNotice?, approved: Boolean, sends: Boolean): String = when {
    sent || notice?.confirmed == true -> "Sent"
    notice != null -> notice.title
    approved -> "Approved"
    sends -> "Approve and send"
    else -> "Approve draft"
}

/** Pure: the stored answer of a Push the household was sent, for [householdPushNotice]. Null for any other draft. */
internal fun sentPushResult(draft: GeneratedDraft): HouseholdPushResult? =
    if (draft.isSentPush) HouseholdPushResult(draft.pushOutcome.trim(), draft.pushReason.trim().ifBlank { null }) else null

/** Pure: what the screen says when the server answers that a draft had already gone. */
internal fun alreadySentNotice(household: String?): SentDraftNotice =
    SentDraftNotice("Already sent", "This message already went to ${household?.trim()?.ifBlank { null } ?: "the household"}. Nothing new was sent.")

/** Pure: what the screen holds after a send that went out just now. */
internal fun justSentNotice(channel: ExternalChannel, result: DraftSendResult): SentDraftNotice =
    SentDraftNotice(
        "Sent",
        "Approved and sent by ${if (channel == ExternalChannel.Email) "email" else "text"}" +
            (if (result.recipientRedacted.isNotBlank()) " to ${result.recipientRedacted}" else "") + ".",
    )

/**
 * Pure: whether the draft callout still says "needs approval". It said so on
 * every open draft, a sent one included. Approved or sent, it does not.
 */
internal fun draftNeedsApproval(sent: Boolean, approved: Boolean): Boolean = !sent && !approved

/**
 * Pure: whether Approve may run at all. Never for a draft that was sent as a
 * KinTale, that is an approved Push (sent, held or unanswered: it has Try
 * again, not Approve), or that is an Email or Text that already went out.
 * The button is off for each of these; this is the same rule for a click that
 * got past it.
 */
internal fun mayApprove(sent: Boolean, pushNotice: HouseholdPushNotice?, sentNotice: SentDraftNotice?): Boolean =
    !sent && pushNotice == null && sentNotice == null

internal sealed interface DraftSendOutcome {
    /** The provider took it. [notice] is what the screen holds. */
    data class Sent(val notice: SentDraftNotice) : DraftSendOutcome
    /** It had already gone, or may have. Nothing new was sent. */
    data class AlreadySent(val notice: SentDraftNotice) : DraftSendOutcome
    /** Nothing went out. The draft is unapproved, so Approve and send is still there. */
    data class Refused(val message: String) : DraftSendOutcome
    /**
     * #2452: the send got no answer, and the server keeps the draft closed.
     * [notice] is held on the screen where Approve and Delete were. Never a
     * toast: it has to still be there after a few seconds.
     */
    data class Unconfirmed(val notice: SentDraftNotice) : DraftSendOutcome
}

/**
 * Runs the one send of an Email or Text draft. [send] is the `sendGeneratedDraft`
 * call; [audit] writes the Activity Log entry and runs only after a real send,
 * never before it and never for a draft that had already gone. Each step is a
 * lambda so the order is testable without a network.
 */
internal suspend fun runDraftSend(
    channel: ExternalChannel,
    household: String?,
    send: suspend () -> WriteResult<String>,
    audit: suspend () -> Unit,
): DraftSendOutcome =
    when (val r = send()) {
        // #2452: told by the refusal's code, never its words.
        is WriteResult.Err ->
            if (r.code == DRAFT_SEND_UNCONFIRMED_CODE) {
                DraftSendOutcome.Unconfirmed(
                    unconfirmedSendNotice(household, if (channel == ExternalChannel.Email) "email" else "sms"),
                )
            } else {
                DraftSendOutcome.Refused(externalSendErrorText(r.message))
            }
        is WriteResult.Ok -> {
            val result = decodeDraftSendResult(r.value)
            if (result.outcome == DRAFT_SENT) {
                audit()
                DraftSendOutcome.Sent(justSentNotice(channel, result))
            } else {
                DraftSendOutcome.AlreadySent(alreadySentNotice(household))
            }
        }
    }
