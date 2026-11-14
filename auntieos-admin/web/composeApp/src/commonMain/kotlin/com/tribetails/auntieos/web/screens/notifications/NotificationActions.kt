package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import com.tribetails.auntieos.web.screens.booking.BookingSeries
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
    /** Book the waiting request (manageBookingSeries APPROVE, #1675). */
    ApproveBooking,
    /** Decline the waiting request (manageBookingSeries CANCEL, #1675). */
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
 * #2069: how a waiting request is known in the live queue: its household and its
 * request id (`batchId`). A batchId is only unique within a household, so both.
 */
fun visitRequestKey(kinfolkId: String, batchId: String): String = "${kinfolkId.trim()}/${batchId.trim()}"

/**
 * #2069: every request still waiting, read off the live incoming-requests queue
 * (collectionGroup kinCares, status == requested) that Bookings lists. Pure.
 */
fun pendingRequestKeys(series: List<BookingSeries>): Set<String> =
    series.map { visitRequestKey(it.kinfolkId, it.batchId) }.toSet()

/**
 * The queue key a `kincare.requested` row names, or null when the row is not a
 * request or names no household or request id (then it cannot be answered).
 */
fun notificationRequestKey(entry: NotificationEntry): String? {
    if (entry.key.trim() != PENDING_BOOKING_REQUEST_KEY) return null
    val kinfolkId = notificationRequestKinfolkId(entry)
    val batchId = entry.targetId.trim()
    if (kinfolkId.isEmpty() || batchId.isEmpty()) return null
    return visitRequestKey(kinfolkId, batchId)
}

/**
 * #2069: true only when the live queue says this row's request is still
 * waiting. [pending] is null while the queue has not loaded or when it failed;
 * then nothing is known to be waiting, so nothing is offered a decision.
 *
 * #1694 (#1647) read "no `requestResolution` stamp" as "still waiting". Rows
 * written before that trigger shipped were never stamped, so requests from
 * August, long booked or declined, kept offering Approve and Deny, and "Needs a
 * decision" counted them. A missing stamp proves nothing; the queue does.
 */
fun isWaitingRequest(entry: NotificationEntry, pending: Set<String>?): Boolean {
    val key = notificationRequestKey(entry) ?: return false
    return pending != null && key in pending
}

/**
 * Which quick actions apply to [entry]. Order is presentation order. Rules:
 *   - exactly one of MarkRead / MarkUnread, by current readAt state,
 *   - OpenTarget only when targetType is navigable AND targetId is non-blank,
 *   - ApproveBooking + DenyBooking only on a `kincare.requested` row whose
 *     request the live queue [pending] still holds ([isWaitingRequest], #2069),
 *   - Archive is always offered.
 *
 * Approve/Deny used to be offered on EVERY booking-targeted row, a booking
 * confirmation included. Web and Android narrowed it to `kincare.requested` in
 * #706 (operator: "most of these don't need most of these ctas"); this build
 * never got that change. #1647 then has the server stamp an answered request,
 * and #2069 asks the queue rather than trusting a stamp that old rows lack.
 * Pure; unit-tested.
 */
fun applicableActions(entry: NotificationEntry, pending: Set<String>? = null): List<NotificationAction> {
    val actions = mutableListOf<NotificationAction>()

    actions += if (notificationIsRead(entry)) NotificationAction.MarkUnread
    else NotificationAction.MarkRead

    val hasTarget = entry.targetId.isNotBlank() &&
        entry.targetType.trim().lowercase() in NAVIGABLE_TARGET_TYPES
    val route = notificationOpenRoute(entry)
    if (hasTarget || route is NotificationOpenRoute.UnappliedPayment || route is NotificationOpenRoute.VisitRequest) {
        actions += NotificationAction.OpenTarget
    }

    // A kinfolk-targeted notification can spawn a quote for that household
    // (targetId is the kinfolkId); other target types have no kinfolk to seed.
    if (entry.targetType.trim().lowercase() == "kinfolk" && entry.targetId.isNotBlank()) {
        actions += NotificationAction.CreateQuote
    }

    if (entry.targetType.trim().lowercase() == "booking" && isWaitingRequest(entry, pending)) {
        actions += NotificationAction.ApproveBooking
        actions += NotificationAction.DenyBooking
    }

    actions += NotificationAction.Archive
    return actions
}

/**
 * How many rows wait on a decision from the operator: the ones offered
 * Approve/Deny by [applicableActions], so the stat and the buttons can never
 * disagree. Replaces the "Dispatched" tile (#1592), as web's
 * `Notifications.tsx` "Needs a decision" did under R5. Pure; unit-tested.
 */
fun needsDecisionCount(entries: List<NotificationEntry>, pending: Set<String>? = null): Int =
    entries.count { NotificationAction.ApproveBooking in applicableActions(it, pending) }
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
fun requestOutcomeLabel(entry: NotificationEntry, pending: Set<String>? = null): String? {
    if (entry.key.trim() != PENDING_BOOKING_REQUEST_KEY) return null
    // #2069: the live queue wins. A request it still holds is waiting.
    if (isWaitingRequest(entry, pending)) return null
    return when (entry.requestResolution.trim().lowercase()) {
        // #2069: no stamp, and the queue (once known) does not hold it: the
        // request was answered or withdrawn before rows were stamped.
        "" -> if (pending != null) "Answered" else null
        "booked" -> "Booked"
        "declined" -> "Declined"
        "cancelled" -> "Cancelled"
        else -> "Answered"
    }
}

/**
 * #1675: the household a waiting request's row belongs to, from `data.kinfolkId`
 * (`onBookingEnvelopeCreate` always writes it), else `data.familyId`. "" when the
 * row names none, and then Approve/Deny are not offered: the request is answered
 * by household and request id. Pure; unit-tested.
 */
fun notificationRequestKinfolkId(entry: NotificationEntry): String =
    entry.dataString("kinfolkId").ifEmpty { entry.dataString("familyId") }

/** What answering a waiting request from its row left on screen: one of the two is set. */
data class RequestAnswer(val error: String?, val notice: String?)

/**
 * #1675: Approve / Deny on a waiting request's row answer the WHOLE request, the
 * `manageBookingSeries` call Bookings' incoming requests make (APPROVE books it,
 * CANCEL declines it). The row's targetId is the request's envelope id
 * (`batchId`); these used to send it to `batchUpdateBookings`, which only knows
 * visit ids, so every press came back not-found. A refusal is the server's own
 * sentence; a partial approval is a failure, not a success.
 */
suspend fun answerBookingRequest(
    client: com.tribetails.auntieos.web.data.FirestoreClient,
    entry: NotificationEntry,
    approve: Boolean,
    /** #1875 / #2030: the operator's note for the household, blank when they left none. */
    note: String = "",
): RequestAnswer {
    val action = if (approve) com.tribetails.auntieos.web.data.BookingSeriesAction.APPROVE
    else com.tribetails.auntieos.web.data.BookingSeriesAction.CANCEL
    val trimmed = note.trim().take(HOUSEHOLD_NOTE_MAX).ifEmpty { null }
    return when (val r = client.manageBookingSeries(action, notificationRequestKinfolkId(entry), entry.targetId.trim(), trimmed)) {
        is com.tribetails.auntieos.web.data.WriteResult.Err -> RequestAnswer(error = r.message, notice = null)
        is com.tribetails.auntieos.web.data.WriteResult.Ok -> {
            val res = r.value
            if (res.failedVisits > 0) {
                RequestAnswer(
                    error = "${if (approve) "Approved" else "Declined"} ${res.affectedVisits} of " +
                        "${res.affectedVisits + res.failedVisits} visits. The rest did not go through and the " +
                        "household has not been told. Open the request in Bookings to finish it.",
                    notice = null,
                )
            } else {
                RequestAnswer(error = null, notice = if (approve) "Request approved." else "Request declined.")
            }
        }
    }
}

/** #2030: the server takes at most this many characters of note with an answer. */
const val HOUSEHOLD_NOTE_MAX = 500

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

    /**
     * #2028: a "Kinfolk requested a KinCare visit" row opens its request on
     * Bookings (the same card Bookings' Visit requests shows), by household and
     * request id. Its targetId is the request's `batchId`, not a booking, so the
     * old booking route had nothing to open.
     */
    data class VisitRequest(val kinfolkId: String, val batchId: String) : NotificationOpenRoute()
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
    if (notificationRequestKey(entry) != null) {
        return NotificationOpenRoute.VisitRequest(notificationRequestKinfolkId(entry), entry.targetId.trim())
    }
    if (entry.key.trim() == UNAPPLIED_PAYMENT_NOTICE_KEY) {
        val kinfolkId = entry.dataString("kinfolkId")
        if (kinfolkId.isNotEmpty()) {
            return NotificationOpenRoute.UnappliedPayment(kinfolkId, entry.dataString("stripeEventId").ifEmpty { null })
        }
    }
    return NotificationOpenRoute.Target(entry.targetType, entry.targetId)
}
