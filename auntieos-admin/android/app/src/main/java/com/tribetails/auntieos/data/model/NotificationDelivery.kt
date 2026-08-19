package com.tribetails.auntieos.data.model

/**
 * "Did it actually go out?" — the Android read model for the delivery pipeline
 * (#396), backed by the `listNotificationDeliveries` callable.
 *
 * `notificationDispatch/{id}` and its `channels/{channel}` subdocs have carried
 * per-channel status, provider message id, skip reason, error text and attempt
 * count since the R5 split, and nothing on either client read a single one of
 * them.
 *
 * WHAT THIS DOES NOT SAY. It never says a message was delivered, because
 * nothing in this system knows that. `status = "sent"` means a provider
 * accepted the message. The smtp2go and Twilio webhooks carrying real
 * delivered/bounced events match `external_messages` by provider message id and
 * never look at these subdocs, so catalog notifications have no receipt to
 * show. [NotificationDeliveryEvidence.receiptAvailable] says so, and
 * [notifDeliveryPhrase] does the wording. Do not upgrade any of it to a green
 * "Delivered".
 */

/** One channel's attempt at one dispatch. */
data class NotificationDeliveryAttempt(
    val channel: String = "",
    /** "pending" | "sent" | "skipped" | "failed" | "unknown", verbatim. */
    val status: String = "unknown",
    val providerMessageId: String? = null,
    val skipReason: String? = null,
    val errorMessage: String? = null,
    val attempts: Int = 0,
    val sentAtMs: Long? = null,
    val failedAtMs: Long? = null,
    val skippedAtMs: Long? = null,
)

/** One work order, with what each of its channels did. */
data class NotificationDeliveryRow(
    val dispatchId: String = "",
    val key: String = "",
    val recipientUid: String = "",
    val status: String = "unknown",
    val mode: String = "",
    val channels: List<String> = emptyList(),
    val createdAtMs: Long? = null,
    val attempts: List<NotificationDeliveryAttempt> = emptyList(),
)

data class NotificationDeliveryEvidence(
    val deliveries: List<NotificationDeliveryRow> = emptyList(),
    /** The ceiling on what "sent" proves, in the server's own words. */
    val sentMeaning: String = "",
    /** False until a provider webhook writes back to these channel subdocs. */
    val receiptAvailable: Boolean = false,
)

private fun longOrNull(raw: Any?): Long? = (raw as? Number)?.toLong()

private fun strOrNull(raw: Any?): String? = (raw as? String)?.takeIf { it.isNotBlank() }

fun notificationDeliveryAttemptFromMap(m: Map<*, *>): NotificationDeliveryAttempt =
    NotificationDeliveryAttempt(
        channel = m["channel"] as? String ?: "",
        // No default of "sent". An attempt carrying no status had no sender run,
        // and the point of this whole surface is that a missing fact reads as
        // missing rather than as success.
        status = (m["status"] as? String)?.takeIf { it.isNotBlank() } ?: "unknown",
        providerMessageId = strOrNull(m["providerMessageId"]),
        skipReason = strOrNull(m["skipReason"]),
        errorMessage = strOrNull(m["errorMessage"]),
        attempts = (m["attempts"] as? Number)?.toInt() ?: 0,
        sentAtMs = longOrNull(m["sentAtMs"]),
        failedAtMs = longOrNull(m["failedAtMs"]),
        skippedAtMs = longOrNull(m["skippedAtMs"]),
    )

fun notificationDeliveryRowFromMap(m: Map<*, *>): NotificationDeliveryRow =
    NotificationDeliveryRow(
        dispatchId = m["dispatchId"] as? String ?: "",
        key = m["key"] as? String ?: "",
        recipientUid = m["recipientUid"] as? String ?: "",
        status = (m["status"] as? String)?.takeIf { it.isNotBlank() } ?: "unknown",
        mode = m["mode"] as? String ?: "",
        channels = stringList(m["channels"]),
        createdAtMs = longOrNull(m["createdAtMs"]),
        attempts = (m["attempts"] as? List<*>).orEmpty().mapNotNull { item ->
            notificationDeliveryAttemptFromMap(item as? Map<*, *> ?: return@mapNotNull null)
        },
    )

fun notificationDeliveryEvidenceFromMap(raw: Map<*, *>): NotificationDeliveryEvidence =
    NotificationDeliveryEvidence(
        deliveries = (raw["deliveries"] as? List<*>).orEmpty().mapNotNull { item ->
            notificationDeliveryRowFromMap(item as? Map<*, *> ?: return@mapNotNull null)
        },
        sentMeaning = raw["sentMeaning"] as? String ?: "",
        // Absent means the backend predates the field, and the safe read of an
        // unknown is "we have no receipt", never "we have one".
        receiptAvailable = raw["receiptAvailable"] as? Boolean ?: false,
    )
