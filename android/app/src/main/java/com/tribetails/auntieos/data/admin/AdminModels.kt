package com.tribetails.auntieos.data.admin

import com.google.firebase.firestore.DocumentId
import com.tribetails.auntieos.data.model.BookingStatus
import java.time.LocalDateTime


enum class EventType {
    KIN_CARE, BLOCKED_DATE, HOLIDAY, PERSONAL
}

data class Event(
    val id: String,
    val title: String,
    val startTime: LocalDateTime,
    val endTime: LocalDateTime,
    val eventType: EventType,
    val status: BookingStatus? = null,
    val notes: String? = null,
    val kinName: String? = null
)

data class AdminProfile(
    val id: String,
    val firstName: String,
    val lastName: String,
    val kinfolkViewName: String,
    val email: String,
    val profilePictureUrl: String?
)

/**
 * Firestore collection: activity_log. Field shape mirrors the web
 * `ActivityLogEntry` data class so a single Firestore doc renders identically
 * on both platforms.
 *
 * Audit hooks (login flows, kinfolk edits, settings changes, reconcile passes)
 * write entries here. Until those hooks are wired, the collection sits empty
 * and the screen renders an honest empty state.
 */
data class ActivityLogEntry(
    @DocumentId val id: String = "",
    var timestamp: String = "",        // ISO-8601
    var actionType: String = "",       // LOGIN | CREATE_BOOKING | UPDATE_SETTINGS | …
    var description: String = "",
    var status: String = "",           // SUCCESS | FAILURE | PENDING
    var actorId: String = "",
    var targetId: String = "",
    var targetCollection: String = "",
    // Hash-chain seal (written by writeAuditEntry). Legacy/admin-SDK entries that
    // predate the chain have no seq and carry blank hashes. seq is a Firestore
    // number, so it maps to Long.
    var seq: Long? = null,
    var prevHash: String = "",
    var entryHash: String = "",
)

/**
 * Firestore collection: `notifications`. Catalog-dispatched notifications
 * written by MyTribe functions notification subsystem. Each doc has a
 * recipient uid + status; AuntieOS Android displays the operator's own
 * inbox of business-side notifications.
 */
data class NotificationEntry(
    @DocumentId val id: String = "",
    var key: String = "",              // catalog key, e.g. 'kincare.booking.confirm'
    var category: String = "",
    var recipientUid: String = "",
    var actorUid: String? = null,
    var status: String = "",           // pending | dispatched
    var mode: String = "",             // trigger | debounced | batched | scheduled
    var channels: List<String> = emptyList(),
    var createdAt: String = "",        // ISO-8601 derived from server timestamp
    // Per-recipient read marker written by bulkMarkNotificationsRead /
    // markNotificationRead (server timestamp). Non-null/non-blank => already read.
    var readAt: String? = null,
    // Step 4 quick-actions: the linked item this notification points at. Written by
    // the dispatcher / createQuote. targetType is one of 'booking' | 'invoice' |
    // 'kintale' | 'kinfolk' | '' (none). targetId is the doc id in that domain.
    var targetType: String = "",
    var targetId: String = "",
    // Archive marker written by archiveNotification / bulkArchiveNotifications
    // (server timestamp). Non-null/non-blank => archived out of the active inbox.
    var archivedAt: String? = null,
)

/**
 * Verdict from the `verifyActivityLogChain` admin callable (mirrors the web
 * ChainVerifyResult). [ok] true means the SHA-256 activity_log chain validated
 * end to end; [anomalyCode] (e.g. "seq_gap", "prev_hash_mismatch",
 * "entry_hash_mismatch", "head_mismatch") names the first break when [ok] is
 * false. [unchainedCount] is legacy/admin-SDK entries that predate the chain.
 */
data class ChainVerifyResult(
    val ok: Boolean,
    val scanned: Int,
    val firstSeq: Int?,
    val lastSeq: Int?,
    val unchainedCount: Int,
    val anomalyCode: String?,
    val anomalySeq: Int? = null,
)
