package com.tribetails.auntieos.data.admin

import java.time.Instant

/**
 * Hand decode for `notifications/{id}` (#1065, Sentry AUNTIEOS-ADMIN-1N).
 *
 * `getNotifications` used `QuerySnapshot.toObjects(NotificationEntry)`. That
 * reflection mapper needs every field to match its Kotlin type, and
 * [NotificationEntry.createdAt] is a String while every server writer stamps
 * `createdAt: FieldValue.serverTimestamp()` (dispatcher.ts, broadcastMessage.ts,
 * promoteQueued.ts). The Android SDK hands that back as a
 * `com.google.firebase.Timestamp`, so the mapper threw on the first doc and the
 * whole inbox failed to load. `readAt` and `archivedAt` are server timestamps
 * too (markNotificationRead.ts, bulkMarkNotificationsRead.ts,
 * archiveNotification.ts), so a read or archived row would have failed the
 * same way.
 *
 * This reads the raw map instead, in the style of `NotificationDelivery`'s
 * `fromMap` helpers. Each timestamp field takes a Timestamp, a Date, epoch
 * millis (Long or Double) or a string, and becomes the ISO-8601 string the
 * screen sorts and formats. A value it cannot read blanks that one field; the
 * row still loads, and one bad doc never fails the list.
 */

/**
 * Timestamp-ish value to ISO-8601, or null when it is absent or unreadable.
 * A bare number is epoch milliseconds, the unit the functions use for `*Ms`.
 */
internal fun notificationInstantToIso(value: Any?): String? = runCatching {
    when (value) {
        null -> null
        is String -> value.takeIf { it.isNotBlank() }
        is com.google.firebase.Timestamp -> value.toDate().toInstant().toString()
        is java.util.Date -> value.toInstant().toString()
        is Long, is Int -> Instant.ofEpochMilli((value as Number).toLong()).toString()
        is Double -> if (value.isFinite()) Instant.ofEpochMilli(value.toLong()).toString() else null
        is Float -> if (value.isFinite()) Instant.ofEpochMilli(value.toLong()).toString() else null
        else -> null
    }
}.getOrNull()

/** A scalar the server wrote as text; a number or boolean is shown as written. */
private fun text(value: Any?): String = when (value) {
    is String -> value
    is Number, is Boolean -> value.toString()
    else -> ""
}

/** Like [text], but keeps an absent or explicit null as null (Class B fields). */
private fun textOrNull(value: Any?): String? = if (value == null) null else text(value)

private fun detailFromMap(raw: Any?): NotificationDetail? {
    val m = raw as? Map<*, *> ?: return null
    return NotificationDetail(
        kinfolkName = text(m["kinfolkName"]),
        kinName = text(m["kinName"]),
        serviceType = text(m["serviceType"]),
        bookingDate = text(m["bookingDate"]),
        bookingTime = text(m["bookingTime"]),
        notes = text(m["notes"]),
        invoiceNumber = text(m["invoiceNumber"]),
        amount = text(m["amount"]),
        dueDate = text(m["dueDate"]),
        requestedBy = text(m["requestedBy"]),
    )
}

private fun dataFromMap(raw: Any?): Map<String, Any?> {
    val m = raw as? Map<*, *> ?: return emptyMap()
    return m.entries.mapNotNull { (k, v) -> (k as? String)?.let { it to v } }.toMap()
}

/** One `notifications` doc to a [NotificationEntry]. Never throws on a field's shape. */
fun notificationEntryFromMap(id: String, m: Map<String, Any?>): NotificationEntry =
    NotificationEntry(
        id = id,
        key = text(m["key"]),
        category = text(m["category"]),
        recipientUid = text(m["recipientUid"]),
        actorUid = textOrNull(m["actorUid"]),
        title = text(m["title"]),
        description = text(m["description"]),
        // Absent and explicit null both stay null (AUNTIEOS-ADMIN-1Q).
        actorName = textOrNull(m["actorName"]),
        detail = detailFromMap(m["detail"]),
        data = dataFromMap(m["data"]),
        createdAt = notificationInstantToIso(m["createdAt"]) ?: "",
        readAt = notificationInstantToIso(m["readAt"]),
        targetType = text(m["targetType"]),
        targetId = text(m["targetId"]),
        archivedAt = notificationInstantToIso(m["archivedAt"]),
    )

/**
 * Decode a page of docs as (id, data) pairs. A doc with no data, or one the
 * mapper still manages to throw on, is dropped and handed to [onDropped];
 * every other doc loads.
 */
fun decodeNotificationDocs(
    docs: List<Pair<String, Map<String, Any?>?>>,
    onDropped: (id: String, cause: Throwable) -> Unit = { _, _ -> },
): List<NotificationEntry> = docs.mapNotNull { (id, data) ->
    if (data == null) {
        onDropped(id, IllegalStateException("notification $id has no data"))
        return@mapNotNull null
    }
    runCatching { notificationEntryFromMap(id, data) }
        .onFailure { onDropped(id, it) }
        .getOrNull()
}
