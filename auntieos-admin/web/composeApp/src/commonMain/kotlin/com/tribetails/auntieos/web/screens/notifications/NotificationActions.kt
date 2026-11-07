package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

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
 *   - ApproveBooking + DenyBooking only on a booking request still waiting on a
 *     decision: key `kincare.requested`, targetType "booking" with a targetId,
 *     and no `requestResolution` stamp ([requestOutcomeLabel] is null),
 *   - Archive is always offered.
 *
 * Approve/Deny used to be offered on EVERY booking-targeted row, a booking
 * confirmation included. Web and Android narrowed it to `kincare.requested` in
 * #706 (operator: "most of these don't need most of these ctas"); this build
 * never got that change. #1647 then has the server stamp an answered request,
 * so a request booked or declined anywhere stops offering a decision here too.
 * Pure; unit-tested.
 */
fun applicableActions(entry: NotificationEntry): List<NotificationAction> {
    val actions = mutableListOf<NotificationAction>()

    actions += if (notificationIsRead(entry)) NotificationAction.MarkUnread
    else NotificationAction.MarkRead

    val hasTarget = entry.targetId.isNotBlank() &&
        entry.targetType.trim().lowercase() in NAVIGABLE_TARGET_TYPES
    if (hasTarget || notificationOpenRoute(entry) is NotificationOpenRoute.UnappliedPayment) {
        actions += NotificationAction.OpenTarget
    }

    // A kinfolk-targeted notification can spawn a quote for that household
    // (targetId is the kinfolkId); other target types have no kinfolk to seed.
    if (entry.targetType.trim().lowercase() == "kinfolk" && entry.targetId.isNotBlank()) {
        actions += NotificationAction.CreateQuote
    }

    if (
        entry.key.trim() == PENDING_BOOKING_REQUEST_KEY &&
        requestOutcomeLabel(entry) == null &&
        entry.targetType.trim().lowercase() == "booking" &&
        entry.targetId.isNotBlank()
    ) {
        actions += NotificationAction.ApproveBooking
        actions += NotificationAction.DenyBooking
    }

    actions += NotificationAction.Archive
    return actions
}

/**
 * The one catalog key that means "a booking request is waiting on a decision"
 * (mytribe/functions/src/notifications/catalog.ts: "Kinfolk requested a KinCare
 * visit"), fired once at the moment of the ask by onBookingEnvelopeCreate.ts.
 */
const val PENDING_BOOKING_REQUEST_KEY = "kincare.requested"

/**
 * #1647: the operator-facing word for how a booking request ended, read off the
 * `requestResolution` stamp the server writes onto the request's rows once it is
 * booked or declined. Null while the request is still waiting, and on every
 * other key. An unrecognised non-blank stamp still counts as answered
 * ("Answered"): the server only stamps a request that has left `requested`.
 * Mirrors web's `requestOutcomeLabel`. Pure; unit-tested.
 */
fun requestOutcomeLabel(entry: NotificationEntry): String? {
    if (entry.key.trim() != PENDING_BOOKING_REQUEST_KEY) return null
    return when (entry.requestResolution.trim().lowercase()) {
        "" -> null
        "booked" -> "Booked"
        "declined" -> "Declined"
        "cancelled" -> "Cancelled"
        else -> "Answered"
    }
}

/** #1003: the admin notice for a card payment that could not be applied. */
const val UNAPPLIED_PAYMENT_NOTICE_KEY = "invoice.payment.unapplied"

/** Where "open linked item" goes for one notification. */
sealed class NotificationOpenRoute {
    /** The default: by the dispatcher's targetType / targetId. */
    data class Target(val targetType: String, val targetId: String) : NotificationOpenRoute()

    /**
     * #1003: the household profile, with "Payments needing a decision" showing
     * and [paymentId]'s Decide dialog open when it is still waiting.
     */
    data class UnappliedPayment(val kinfolkId: String, val paymentId: String?) : NotificationOpenRoute()
}

private fun NotificationEntry.dataString(key: String): String =
    (data?.get(key) as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()

/**
 * The route for [entry]. Only `invoice.payment.unapplied` with a kinfolkId in
 * its data is overridden (its server targetType is `invoice`, but the decision
 * lives on the household); the notice's `stripeEventId` IS the paymentId. Every
 * other key keeps the targetType / targetId route. Pure; unit-tested.
 */
fun notificationOpenRoute(entry: NotificationEntry): NotificationOpenRoute {
    if (entry.key.trim() == UNAPPLIED_PAYMENT_NOTICE_KEY) {
        val kinfolkId = entry.dataString("kinfolkId")
        if (kinfolkId.isNotEmpty()) {
            return NotificationOpenRoute.UnappliedPayment(kinfolkId, entry.dataString("stripeEventId").ifEmpty { null })
        }
    }
    return NotificationOpenRoute.Target(entry.targetType, entry.targetId)
}
