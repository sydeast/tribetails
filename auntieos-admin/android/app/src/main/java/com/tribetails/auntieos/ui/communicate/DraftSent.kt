package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.MessageDraftStanding
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * #2428: a Communicate draft that already went out, and the one send of an
 * Email or Text draft.
 *
 * Communicate opened every stored draft as "needs approval", with Approve and
 * send and Delete draft, unless it was a sent KinTale or a held Push. A Push
 * the household already had, and an Email or Text that had already gone, opened
 * the same way as a draft nobody had touched, and approving the Email or Text
 * again sent it again. Nothing on the draft said it had gone: this screen
 * approved it with its own write and then called `sendExternalMessage`, which
 * has never heard of the draft.
 *
 * Now the `sendGeneratedDraft` callable approves, sends and stamps the draft in
 * one call, and a stored draft is read for what it carries ([Draft.isSentPush],
 * [Draft.sentMessageChannel]). Same rules and the same sentences as the web
 * admin's `lib/draftSent.ts`.
 *
 * #2452: a send that got no answer is told apart from one that went
 * ([Draft.messageStanding]) and has its own notice, on open and in the sitting
 * where it happened. #2440: the day in a notice is the business's day.
 */

/** What `sendGeneratedDraft` answered. */
data class DraftSendResult(
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
internal fun decodeDraftSendResult(raw: Map<String, Any?>?): DraftSendResult = DraftSendResult(
    outcome = if (raw?.get("outcome") == DRAFT_SENT) DRAFT_SENT else DRAFT_ALREADY_SENT,
    recipientRedacted = (raw?.get("recipientRedacted") as? String).orEmpty(),
)

/**
 * What the screen shows in place of Approve for an Email or Text that is past
 * approving. [confirmed] is false when the notice does not vouch for a send
 * (#2452): the send got no answer, or is still running.
 */
data class SentDraftNotice(val title: String, val body: String, val confirmed: Boolean = true)

private val SENT_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

/**
 * "Nov 20, 2026" on the business's calendar, or blank when the stamp is
 * missing or unreadable. #2440: [zone] is the business's
 * (`businessZone(settings.timeZone)`), never the phone's. It has no default,
 * so no caller reads the phone's zone by leaving it out.
 */
internal fun sentDayOf(iso: String?, zone: ZoneId): String =
    try {
        if (iso.isNullOrBlank()) "" else Instant.parse(iso.trim()).atZone(zone).format(SENT_DAY)
    } catch (_: Exception) {
        ""
    }

private fun channelWord(channel: String): String = if (channel == "email") "email" else "text"

/**
 * Pure: the notice for an opened Email or Text draft that already went out, or
 * null for any other draft. A stamped one says who, how and when. An approved
 * one with no stamp says it was approved, never that a delivery was recorded.
 */
internal fun sentDraftNotice(
    draft: Draft,
    household: String,
    zone: ZoneId,
    nowMs: Long = System.currentTimeMillis(),
): SentDraftNotice? {
    val channel = draft.sentMessageChannel ?: return null
    val who = household.trim().ifBlank { "the household" }
    val how = channelWord(channel)
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
internal fun unconfirmedSendNotice(household: String, channel: String?, day: String = ""): SentDraftNotice {
    val how = when (channel) {
        "email" -> "email"
        "sms" -> "text"
        else -> "message"
    }
    val who = household.trim().ifBlank { "the household" }
    return SentDraftNotice(
        "Send not confirmed",
        "The send of this $how to $who${if (day.isNotBlank()) " on $day" else ""} did not get an answer, " +
            "so it is not known whether it reached them. It is not sent again from this draft. " +
            "Write a new one if it has to go again.",
        confirmed = false,
    )
}

/** #2452: the `details.code` of the refusal `sendGeneratedDraft` gives when a send got no answer. */
internal const val DRAFT_SEND_UNCONFIRMED_CODE = "draft_send_unconfirmed"

/**
 * #2452: `sendGeneratedDraft` refused because the send got no answer. The
 * repository throws this in place of the callable's own error when the refusal
 * carries [DRAFT_SEND_UNCONFIRMED_CODE], so the screen tells it by its type
 * and never by its words.
 */
class DraftSendUnconfirmedException(message: String?, cause: Throwable? = null) : Exception(message, cause)

/** Pure: the failure the repository hands on for a refused send, by the refusal's `details.code`. */
internal fun draftSendFailure(code: String?, cause: Throwable): Throwable =
    if (code == DRAFT_SEND_UNCONFIRMED_CODE) DraftSendUnconfirmedException(cause.message, cause) else cause

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
internal fun sentPushResult(draft: Draft): HouseholdPushResult? =
    if (draft.isSentPush) HouseholdPushResult(draft.pushOutcome.trim(), draft.pushReason.ifBlank { null }) else null

/** Pure: what the screen says when the server answers that a draft had already gone. */
internal fun alreadySentNotice(household: String): SentDraftNotice =
    SentDraftNotice("Already sent", "This message already went to ${household.trim().ifBlank { "the household" }}. Nothing new was sent.")

/** Pure: the line after a send that went out just now. */
internal fun draftSentMessage(channel: ExternalChannel, result: DraftSendResult): String =
    "Draft approved and sent by ${if (channel == ExternalChannel.Email) "email" else "text"}" +
        (if (result.recipientRedacted.isNotBlank()) " to ${result.recipientRedacted}" else "") + "."
/**
 * Pure: whether the draft callout still says "needs approval". It said so on
 * every open draft, a sent one included. Approved or sent, it does not.
 */
internal fun draftNeedsApproval(sent: Boolean, approved: Boolean): Boolean = !sent && !approved
