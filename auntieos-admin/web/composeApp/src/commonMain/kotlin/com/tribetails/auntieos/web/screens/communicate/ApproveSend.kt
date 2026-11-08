package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.WriteResult

/**
 * #1625: approving a Text or Email draft in the desktop console sends it, the
 * way the React admin's `approveGeneratedDraft` does. Before this the console
 * stamped the draft `approved`, logged it, and toasted "approved and queued for
 * delivery" while nothing queued it, so the household never got the message.
 *
 * The order is the web admin's: the draft write is a gate (no send after a
 * refused write), the audit entry follows it, and the send runs last. A refused
 * send leaves the draft approved and says the household did not get it.
 */

/** The channel an approved draft of [type] goes out on, or null when approving sends nothing. Pure. */
internal fun approveDeliveryChannel(type: MessageType): ExternalChannel? = when (type) {
    MessageType.Email -> ExternalChannel.Email
    MessageType.Text -> ExternalChannel.Sms
    MessageType.Visit, MessageType.Blog -> null
}

private fun Kinfolk.nameForCopy(): String =
    "$firstName $lastName".trim().ifBlank { "This household" }

/**
 * Why the approve cannot go ahead yet, or null when it can. Mirrors the React
 * admin's `approveBlocker` word for word. Pure.
 */
internal fun approveSendBlocker(channel: ExternalChannel?, kinfolk: Kinfolk?, subject: String, copy: String): String? {
    if (copy.isBlank()) return "The message is empty. Write something before approving."
    if (channel == null) return null
    if (channel == ExternalChannel.Email && subject.isBlank()) return "Email needs a subject."
    val name = kinfolk?.nameForCopy() ?: "This household"
    if (channel == ExternalChannel.Email && kinfolk?.email.isNullOrBlank()) {
        return "$name has no email address on file. Add one in Directory before sending."
    }
    if (channel == ExternalChannel.Sms && kinfolk?.phoneNumber.isNullOrBlank()) {
        return "$name has no phone number on file. Add one in Directory before sending."
    }
    return null
}

/** The address [channel] sends to for [kinfolk]. Pure. */
internal fun approveSendAddress(channel: ExternalChannel, kinfolk: Kinfolk): String =
    if (channel == ExternalChannel.Email) kinfolk.email.trim() else kinfolk.phoneNumber.trim()

sealed interface ApproveOutcome {
    /** The draft write was refused. Nothing was logged or sent. */
    data class WriteRefused(val message: String) : ApproveOutcome
    /** Approved; this type sends nothing from here. */
    data object Approved : ApproveOutcome
    /** Approved and handed to the provider. */
    data class Sent(val channel: ExternalChannel, val recipientRedacted: String) : ApproveOutcome
    /** Approved, but the provider refused the send. The household did not get it. */
    data class SendFailed(val message: String) : ApproveOutcome
}

/**
 * Runs the approve in the web admin's order. [send] is null for a type that
 * delivers nothing. Each step is a lambda so the order is testable without a
 * network.
 */
internal suspend fun runApprove(
    write: suspend () -> WriteResult<Unit>,
    audit: suspend () -> Unit,
    channel: ExternalChannel?,
    send: (suspend () -> WriteResult<ExternalSendResult>)?,
): ApproveOutcome {
    when (val w = write()) {
        is WriteResult.Err -> return ApproveOutcome.WriteRefused(w.message)
        is WriteResult.Ok -> Unit
    }
    audit()
    if (channel == null || send == null) return ApproveOutcome.Approved
    return when (val r = send()) {
        is WriteResult.Ok -> ApproveOutcome.Sent(channel, r.value.recipientRedacted)
        is WriteResult.Err -> ApproveOutcome.SendFailed(externalSendErrorText(r.message))
    }
}

/** The toast line for an [ApproveOutcome]. Never claims a delivery that did not happen. Pure. */
internal fun approveOutcomeText(outcome: ApproveOutcome): String = when (outcome) {
    // #1592: no draft id and no database name; the operator knows which draft
    // they just approved, and "Firestore rejected it" named the store.
    is ApproveOutcome.WriteRefused -> "Could not approve: ${outcome.message}"
    ApproveOutcome.Approved -> "Draft approved and logged. This type sends nothing from here."
    is ApproveOutcome.Sent ->
        "Draft approved and sent by ${if (outcome.channel == ExternalChannel.Email) "email" else "text"} to ${outcome.recipientRedacted}."
    is ApproveOutcome.SendFailed -> "The draft is approved, but the send failed: ${outcome.message}"
}
