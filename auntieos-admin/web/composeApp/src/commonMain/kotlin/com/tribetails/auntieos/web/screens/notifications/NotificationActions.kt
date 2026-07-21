package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry

/**
 * Pure (unit-tested) logic for the Notifications screen quick actions, kept out of
 * the composable so the decisions can be tested on plain JVM with no Compose.
 *
 * Three concerns live here:
 *   1. which rows are shown by default (archived filtered out),
 *   2. which quick actions apply to a given notification (by targetType + readAt),
 *   3. the read/unread state read off the real `readAt` field.
 *
 * Nothing here invents data: every decision reads only fields the dispatcher / the
 * read + archive callables actually write.
 */

/** The quick actions a single notification row can offer. */
enum class NotificationAction {
    /** Toggle read -> unread (markNotificationRead). Shown when currently unread. */
    MarkRead,
    /** Toggle unread -> read (markNotificationUnread). Shown when currently read. */
    MarkUnread,
    /** Open the linked booking/invoice/kintale/kinfolk (needs targetType + targetId). */
    OpenTarget,
    /** Archive out of the active inbox (archiveNotification). Always available. */
    Archive,
    /** Approve the linked booking (batchUpdateBookings APPROVE). booking-only. */
    ApproveBooking,
    /** Deny the linked booking (batchUpdateBookings REJECT). booking-only. */
    DenyBooking,
    /** Compose a quote for the linked kinfolk (createQuote). kinfolk-target only. */
    CreateQuote,
}

/** The target types the "open linked item" + approve/deny actions understand. */
internal val NAVIGABLE_TARGET_TYPES = setOf("booking", "invoice", "kintale", "kinfolk")

/**
 * The active inbox: notifications that have NOT been archived. The default list
 * filters these out so archived rows never resurface unless explicitly requested.
 * Pure; unit-tested.
 */
fun activeNotifications(all: List<NotificationEntry>): List<NotificationEntry> =
    all.filter { !it.isArchived }

/**
 * The read/unread state for the row, driven by the real `readAt` field (NOT the
 * pending-dispatch proxy). Blank readAt == unread.
 */
fun notificationIsRead(entry: NotificationEntry): Boolean = entry.isRead

/**
 * Which quick actions apply to [entry]. Order is presentation order. Rules:
 *   - exactly one of MarkRead / MarkUnread, by current readAt state,
 *   - OpenTarget only when targetType is navigable AND targetId is non-blank,
 *   - ApproveBooking + DenyBooking only when targetType == "booking" with a targetId,
 *   - Archive is always offered.
 * Pure; unit-tested.
 */
fun applicableActions(entry: NotificationEntry): List<NotificationAction> {
    val actions = mutableListOf<NotificationAction>()

    actions += if (notificationIsRead(entry)) NotificationAction.MarkUnread
    else NotificationAction.MarkRead

    val hasTarget = entry.targetId.isNotBlank() &&
        entry.targetType.trim().lowercase() in NAVIGABLE_TARGET_TYPES
    if (hasTarget) actions += NotificationAction.OpenTarget

    // A kinfolk-targeted notification can spawn a quote for that household
    // (targetId is the kinfolkId); other target types have no kinfolk to seed.
    if (entry.targetType.trim().lowercase() == "kinfolk" && entry.targetId.isNotBlank()) {
        actions += NotificationAction.CreateQuote
    }

    if (entry.targetType.trim().lowercase() == "booking" && entry.targetId.isNotBlank()) {
        actions += NotificationAction.ApproveBooking
        actions += NotificationAction.DenyBooking
    }

    actions += NotificationAction.Archive
    return actions
}
