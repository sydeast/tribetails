package com.tribetails.auntieos.data.admin

import androidx.annotation.Keep
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
@Keep
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
    // ── The forensic fields (operator ruling R5, 2026-08-03) ─────────────────
    // "the Activity Log is seriously lacking, cant see shit or what the fuck
    // actually happened."
    //
    // `writeAuditEntry` has sealed every one of these onto every entry since
    // 2026-05-19; its own docstring calls them "retained for forensic value ...
    // surfaced in detail views", and no detail view existed on either platform.
    // So `payload`, the field where each event type records its specifics
    // (writeAuditEntry gives it nowhere else), was read by nothing.
    //
    // Untyped on purpose: the payload shape is per-event-type and has no schema.
    // Read it through `activityPayloadRows` in ui/admin/ActivityLogScreen.kt.
    var payload: Map<String, Any?> = emptyMap(),
    var severity: String = "",         // info | warn | critical
    var actorRole: String = "",        // SYSTEM | PRIMARY | AUNTIE | …
    var familyId: String = "",
    var requestId: String = "",
    var clientRequestId: String = "",
    var ip: String = "",
    var userAgent: String = "",
)

/**
 * The entity detail a notification CARD renders, resolved server-side at dispatch
 * and stamped on `notifications/{id}.detail` (operator ruling R5, 2026-08-03).
 * Mirrors `NotificationDetail` in mytribe/functions/src/notifications/types.ts
 * and the web `NotificationDetail` in src/api/notifications.ts.
 *
 * The operator's list, verbatim: "Who requested, For which kinfolk, what date,
 * what time, wheres the notes." Every one of those was already being computed by
 * `enrichTemplateData` to fill merge fields in the outbound email, then thrown
 * away, so the card said "A KinCare visit was assigned" and nothing else.
 *
 * BLANK MEANS UNRESOLVED. Kotlin has no absent-vs-empty distinction for a
 * non-null String field the way the wire format does, so the renderer's rule is
 * simply: a blank field renders no line. Never a placeholder.
 */
@Keep
data class NotificationDetail(
    var kinfolkName: String = "",
    var kinName: String = "",
    var serviceType: String = "",
    var bookingDate: String = "",
    var bookingTime: String = "",
    var notes: String = "",
    var invoiceNumber: String = "",
    var amount: String = "",
    var dueDate: String = "",
    var requestedBy: String = "",
)

/**
 * Firestore collection: `notifications`. Catalog-dispatched notifications
 * written by the MyTribe functions notification subsystem. AuntieOS Android
 * displays the operator's own inbox of business-side notifications.
 *
 * NO DELIVERY STATE (operator ruling R5, 2026-08-03). `status`, `mode` and
 * `channels` used to be fields here and were rendered as primary card content:
 * the row printed "bookings · trigger", a "channels: email, sms" line and a
 * dispatch-status pill, and the stat strip carried a "Dispatched" tile. The
 * ruling was blunt: "Channels, trigger, and dispatched are activity log not
 * notification." That state now lives on `notificationDispatch/{id}` (id-matched
 * to the notification) and the RECORD of it goes to the hash-chained
 * `activity_log` as NOTIFICATION_DISPATCHED / NOTIFICATION_RECEIVED.
 *
 * Legacy documents still carry those three fields on the wire; Firestore's POJO
 * deserializer ignores unknown fields, so they simply stop arriving. That is what
 * makes `mytribe/scripts/backfillNotificationDeliverySplit.ts` a convergence step
 * rather than a prerequisite for this build.
 */
@Keep
data class NotificationEntry(
    @DocumentId val id: String = "",
    var key: String = "",              // catalog key, e.g. 'kincare.booking.confirm'
    var category: String = "",
    var recipientUid: String = "",
    var actorUid: String? = null,
    // AO-28 content, written by dispatcher.ts from the catalog def: `title` is
    // the label, `description` the description, `actorName` the resolved actor.
    // Blank on rows dispatched before AO-28, so the row falls back to `key`.
    var title: String = "",
    var description: String = "",
    // Nullable per the Class B decode rule: dispatcher.ts omits `actorName` for
    // system-originated notifications and older rows store it as an explicit
    // null, so a non-null String setter throws under toObject() and blanks the
    // entire notifications query. Crashed /home on 0.2.0.810 (AUNTIEOS-ADMIN-1Q).
    var actorName: String? = "",
    // R5 entity detail. Null when the server resolved nothing for this
    // notification (or on a doc written before the split), which the row reads
    // as "this card has nothing to open".
    var detail: NotificationDetail? = null,
    // The emitter's free-form merge bag (`data: args.data` in dispatcher.ts).
    // Untyped on purpose: it is whatever the calling function passed to
    // enqueueNotification, with no schema. It is where the household reference
    // lives for most notifications; see notificationKinfolkId in
    // ui/admin/NotificationsScreen.kt for how it is read safely.
    var data: Map<String, Any?> = emptyMap(),
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
