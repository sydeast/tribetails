package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.GeneratedDraft
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

/** What the screen shows in place of Approve for an Email or Text that already went out. */
internal data class SentDraftNotice(val title: String, val body: String)

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
internal fun sentDraftNotice(draft: GeneratedDraft, household: String, zone: TimeZone): SentDraftNotice? {
    val channel = draft.sentMessageChannel ?: return null
    val who = household.trim().ifBlank { "the household" }
    val how = if (channel == "email") "email" else "text"
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
        is WriteResult.Err -> DraftSendOutcome.Refused(externalSendErrorText(r.message))
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
