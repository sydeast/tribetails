package com.tribetails.auntieos.ui.communicate

import com.tribetails.auntieos.data.model.Draft
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

/** What the screen shows in place of Approve for an Email or Text that already went out. */
data class SentDraftNotice(val title: String, val body: String)

private val SENT_DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

/** "Nov 20, 2026" in the phone's zone, or blank when the stamp is missing or unreadable. */
internal fun sentDayOf(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String =
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
internal fun sentDraftNotice(draft: Draft, household: String, zone: ZoneId = ZoneId.systemDefault()): SentDraftNotice? {
    val channel = draft.sentMessageChannel ?: return null
    val who = household.trim().ifBlank { "the household" }
    val how = channelWord(channel)
    if (draft.sentAt.isNotBlank()) {
        val day = sentDayOf(draft.sentAt, zone)
        return SentDraftNotice("Already sent", "Sent to $who by $how${if (day.isNotBlank()) " on $day" else ""}. It is not sent again.")
    }
    val day = sentDayOf(draft.approvedAt, zone)
    return SentDraftNotice(
        "Already approved",
        "This $how for $who was approved${if (day.isNotBlank()) " on $day" else ""}. Approving sends it, so it is not sent again.",
    )
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
