package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.admin.NotificationDetail
import com.tribetails.auntieos.data.admin.NotificationEntry
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/**
 * Tolerant decoder for `notifications/{id}`, replacing reflection `toObjects`
 * (#1065, AUNTIEOS-ADMIN-1N).
 *
 * WHY. Every MyTribe writer of this collection (`notifications/dispatcher.ts`,
 * `notifications/promoteQueued.ts`, `admin/broadcastMessage.ts`) stamps
 * `createdAt: FieldValue.serverTimestamp()`, and `readAt` / `archivedAt` are
 * server timestamps too. They arrive as [com.google.firebase.Timestamp], and
 * `toObjects` into the String fields of [NotificationEntry] threw
 * "Failed to convert value of type Timestamp to String (found in field
 * 'createdAt')", which failed the WHOLE inbox on one field of one doc.
 *
 * WHAT. Each instant field accepts a Timestamp, a [java.util.Date], a [Number]
 * (epoch milliseconds) or a String, and is normalised to ISO-8601 UTC
 * ([Instant.toString], e.g. `2026-06-27T17:07:24.579Z`), which is the shape
 * NotificationsScreen and AdminDataViewModel sort and render. A value that is
 * present but unreadable is not guessed at: the field decodes blank/null and the
 * problem is returned in [NotificationDecode.problems] so the repository can
 * report it. The row still renders ("(no time)") rather than vanishing.
 */
internal data class NotificationDecode(
    val entry: NotificationEntry,
    /** Field-level problems, by field name and wire type only (no content). */
    val problems: List<String> = emptyList(),
)

/** Outcome of reading one instant field. */
internal sealed interface InstantField {
    /** Absent, null or blank on the wire. */
    data object Absent : InstantField
    data class Iso(val iso: String) : InstantField
    /** Present but not an instant this decoder can read; [what] names why. */
    data class Unreadable(val what: String) : InstantField
}

/**
 * Normalise a Firestore "timestamp-ish" value to ISO-8601 UTC. See the file doc
 * for the accepted shapes. A String without an offset (a bare local date-time)
 * is Unreadable: the instant it names depends on a zone nobody recorded.
 */
internal fun notificationInstant(raw: Any?): InstantField = when (raw) {
    null -> InstantField.Absent
    is com.google.firebase.Timestamp ->
        InstantField.Iso(Instant.ofEpochSecond(raw.seconds, raw.nanoseconds.toLong()).toString())
    is java.util.Date -> InstantField.Iso(raw.toInstant().toString())
    is Number -> {
        val d = raw.toDouble()
        if (d.isNaN() || d.isInfinite()) InstantField.Unreadable("Number(non-finite)")
        else InstantField.Iso(Instant.ofEpochMilli(raw.toLong()).toString())
    }
    is String -> {
        val s = raw.trim()
        if (s.isEmpty()) InstantField.Absent else parseIsoInstant(s)
            ?.let { InstantField.Iso(it.toString()) }
            ?: InstantField.Unreadable("String(unparseable)")
    }
    else -> InstantField.Unreadable(raw.javaClass.simpleName)
}

private fun parseIsoInstant(s: String): Instant? =
    try {
        Instant.parse(s)
    } catch (_: DateTimeParseException) {
        try {
            OffsetDateTime.parse(s).toInstant()
        } catch (_: DateTimeParseException) {
            null
        }
    }

private fun str(raw: Any?): String = raw as? String ?: ""

private fun strOrNull(raw: Any?): String? = raw as? String

private fun detailFromMap(m: Map<*, *>): NotificationDetail = NotificationDetail(
    kinfolkName = str(m["kinfolkName"]),
    kinName = str(m["kinName"]),
    serviceType = str(m["serviceType"]),
    bookingDate = str(m["bookingDate"]),
    bookingTime = str(m["bookingTime"]),
    notes = str(m["notes"]),
    invoiceNumber = str(m["invoiceNumber"]),
    amount = str(m["amount"]),
    dueDate = str(m["dueDate"]),
    requestedBy = str(m["requestedBy"]),
)

/**
 * Decode one `notifications/{id}` document. Never throws on field shape: a
 * wrong-typed field decodes to its model default, and an unreadable instant is
 * listed in [NotificationDecode.problems].
 */
internal fun decodeNotificationEntry(id: String, m: Map<String, Any?>): NotificationDecode {
    val problems = mutableListOf<String>()
    fun instant(field: String): String? = when (val f = notificationInstant(m[field])) {
        InstantField.Absent -> null
        is InstantField.Iso -> f.iso
        is InstantField.Unreadable -> {
            problems += "$field:${f.what}"
            null
        }
    }
    val createdAt = instant("createdAt")
    if (createdAt == null && m["createdAt"] == null) problems += "createdAt:missing"
    val entry = NotificationEntry(
        id = id,
        key = str(m["key"]),
        category = str(m["category"]),
        recipientUid = str(m["recipientUid"]),
        actorUid = strOrNull(m["actorUid"]),
        title = str(m["title"]),
        description = str(m["description"]),
        actorName = strOrNull(m["actorName"]),
        detail = (m["detail"] as? Map<*, *>)?.let(::detailFromMap),
        data = (m["data"] as? Map<*, *>).orEmpty()
            .mapNotNull { (k, v) -> (k as? String)?.let { it to v } }
            .toMap(),
        createdAt = createdAt.orEmpty(),
        readAt = instant("readAt"),
        targetType = str(m["targetType"]),
        targetId = str(m["targetId"]),
        archivedAt = instant("archivedAt"),
    )
    return NotificationDecode(entry, problems)
}
