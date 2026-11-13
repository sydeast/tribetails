package com.kinfolk.portal.portal

import kotlin.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * The notifications list behind the header bell (#1316): the wire shape of
 * `listMyNotifications` (functions/src/portal/listMyNotifications.ts) and the
 * two pure rules the screen needs, where a tap goes and what the bell draws.
 * Pure Kotlin, tested in commonTest without a Compose runtime.
 */

/** One row. [readAtMs] is null while unread: the server stamps it only on a read. */
data class NotificationItem(
    val id: String,
    val key: String,
    val category: String,
    val title: String,
    val description: String,
    val actorName: String,
    val actorPhotoUrl: String,
    /** 'booking' | 'invoice' | 'kintale' | 'kinfolk' | 'conversation' | '' as the dispatcher resolved it. */
    val targetType: String,
    val targetId: String,
    /**
     * The visit, when the row is about one visit. Null for a row about a whole
     * booking request, whose [targetId] is the request's batch id, not a visit.
     */
    val visitId: String?,
    /** The booking request (envelope) the row names, when it names one. */
    val batchId: String?,
    /** When it happened, or null when the row holds no readable time. */
    val createdAtMs: Long?,
    /** When it was read, null while unread. */
    val readAtMs: Long?,
) {
    val unread: Boolean get() = readAtMs == null
}

data class NotificationsPage(
    val items: List<NotificationItem>,
    /** The same number `getMyHome.unreadNotifications` carries, from the same server helper. */
    val unreadCount: Int,
    val hasMore: Boolean,
    /** Cursor for the next page (`before`), or null at the end. */
    val nextBefore: Long?,
)

/** Where a tapped row goes. [None] stays on the list, read but not opened. */
sealed interface NotificationTarget {
    data class Visit(val visitId: String, val batchId: String?) : NotificationTarget
    data class BookingRequest(val batchId: String) : NotificationTarget
    data object Schedule : NotificationTarget
    data class Invoice(val invoiceId: String) : NotificationTarget
    data class KinTale(val taleId: String) : NotificationTarget
    /** #1874: a reply from the office opens Messages. */
    data object Messages : NotificationTarget
    data object None : NotificationTarget
}

/**
 * The thing a row is about, read off the dispatcher's `targetType`.
 *
 * A booking row's `targetId` is a VISIT for per-visit events and a BATCH for
 * whole-request events (the request, its approval, a decline), and the id
 * alone cannot say which. So the visit opens only when the row carries a
 * `visitId`; a whole-request row opens the request when it names its batch,
 * and a booking row this client cannot place lands on Schedule rather than on
 * a visit page that says "not found".
 */
fun notificationTargetOf(item: NotificationItem): NotificationTarget {
    val id = item.targetId.trim()
    return when (item.targetType) {
        "booking" -> {
            val visitId = item.visitId?.trim().orEmpty()
            val batchId = item.batchId?.trim().orEmpty()
            when {
                visitId.isNotEmpty() -> NotificationTarget.Visit(visitId, batchId.ifEmpty { null })
                batchId.isNotEmpty() -> NotificationTarget.BookingRequest(batchId)
                else -> NotificationTarget.Schedule
            }
        }
        "invoice" -> if (id.isEmpty()) NotificationTarget.None else NotificationTarget.Invoice(id)
        "kintale" -> if (id.isEmpty()) NotificationTarget.None else NotificationTarget.KinTale(id)
        "conversation" -> NotificationTarget.Messages
        else -> NotificationTarget.None
    }
}

/** Epoch millis from an ISO-8601 string, or null for a missing or unreadable one. Never a fabricated time. */
internal fun isoToEpochMs(iso: String?): Long? {
    if (iso.isNullOrBlank()) return null
    return runCatching { Instant.parse(iso).toEpochMilliseconds() }.getOrNull()
}

/** One row off the wire, or null when it has no id (a row nothing can act on). */
fun decodeNotificationItem(o: JsonObject): NotificationItem? {
    val id = o["id"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return null
    fun str(k: String) = o[k]?.jsonPrimitive?.contentOrNull.orEmpty()
    fun strOrNull(k: String) = o[k]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
    return NotificationItem(
        id = id,
        key = str("key"),
        category = str("category"),
        title = str("title"),
        description = str("description"),
        actorName = str("actorName"),
        actorPhotoUrl = str("actorPhotoUrl"),
        targetType = str("targetType"),
        targetId = str("targetId"),
        visitId = strOrNull("visitId"),
        batchId = strOrNull("batchId"),
        createdAtMs = isoToEpochMs(o["createdAt"]?.jsonPrimitive?.contentOrNull),
        readAtMs = isoToEpochMs(o["readAt"]?.jsonPrimitive?.contentOrNull),
    )
}

/** The whole page. Lenient like the other decoders here: a bad row is dropped, a missing field defaults. */
fun decodeNotificationsPage(raw: JsonObject): NotificationsPage {
    val items = (raw["items"] as? JsonArray)
        ?.mapNotNull { (it as? JsonObject)?.let(::decodeNotificationItem) }
        .orEmpty()
    return NotificationsPage(
        items = items,
        unreadCount = raw["unreadCount"]?.jsonPrimitive?.intOrNull?.coerceAtLeast(0) ?: items.count { it.unread },
        hasMore = raw["hasMore"]?.jsonPrimitive?.booleanOrNull ?: false,
        nextBefore = raw["nextBefore"]?.jsonPrimitive?.longOrNull,
    )
}
