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
 * #2367: the shape every id must have before it goes into a route, a screen or
 * a [visitRequestKey]: 1 to 200 of `A-Z a-z 0-9 _ . : ~ + -`, and not "." or
 * "..". The same rule as Android's `pushId` (ui/PushOpen.kt). A slash, a `?`,
 * a space or a blank never passes, so a `household/request` key can always be
 * split back into its two ids. Checks the trimmed id. Pure; unit-tested.
 */
fun isSafeNoticeId(id: String): Boolean {
    val t = id.trim()
    return t != "." && t != ".." && SAFE_NOTICE_ID.matches(t)
}

private val SAFE_NOTICE_ID = Regex("^[A-Za-z0-9_.:~+-]{1,200}$")

/**
 * #2367: the household and request id a [visitRequestKey] was built from, or
 * null when the key is not exactly two ids that pass [isSafeNoticeId]. Pure.
 */
fun parseVisitRequestKey(key: String?): Pair<String, String>? {
    val parts = key?.trim()?.split('/') ?: return null
    if (parts.size != 2) return null
    val (kinfolkId, batchId) = parts
    if (!isSafeNoticeId(kinfolkId) || !isSafeNoticeId(batchId)) return null
    return kinfolkId.trim() to batchId.trim()
}

/**
 * #2367: the household and booking a WHOLE-BOOKING notice names, or null when
 * [entry] is not one. A whole booking is a `booking` target whose `data.batchId`
 * is its targetId (`kincare.requested`, `kincare.booking.confirm`,
 * `kincare.request.declined`, `assignment.assigned`), with a household id, both
 * ids passing [isSafeNoticeId]. Its targetId is a request id, not a visit id, so
 * the visit route built `vis_{batchId}`, which matches no KinCare. Pure.
 */
fun wholeBookingTarget(entry: NotificationEntry): Pair<String, String>? {
    if (!isBatchTarget(entry)) return null
    val batchId = entry.dataString("batchId")
    val kinfolkId = notificationRequestKinfolkId(entry)
    if (!isSafeNoticeId(kinfolkId) || !isSafeNoticeId(batchId)) return null
    return kinfolkId to batchId
}

/** #2367: a `booking` target whose targetId is its `data.batchId`: it names a whole booking, not a visit. */
private fun isBatchTarget(entry: NotificationEntry): Boolean {
    if (entry.targetType.trim().lowercase() != "booking") return false
    val batchId = entry.dataString("batchId")
    return batchId.isNotEmpty() && batchId == entry.targetId.trim()
}

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

    // #2367: Open shows exactly when Open would land somewhere. A booking id that
    // fails [isSafeNoticeId] opens nothing, so it offers no button either.
    val opens = when (val route = notificationOpenRoute(entry)) {
        is NotificationOpenRoute.Target ->
            notificationTargetScreen(route.targetType, route.targetId) != NotificationTargetScreen.None
        is NotificationOpenRoute.UnappliedPayment, is NotificationOpenRoute.VisitRequest -> true
        NotificationOpenRoute.None -> false
    }
    if (opens) {
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

/**
 * The prefix `kin_care_sessions` ids carry over the visit id they were made
 * from. A notification's `booking` target is the VISIT id; the KinCare detail
 * screen matches on the session id. Android (`sessionIdForVisit` in
 * Navigation.kt) and admin web (`lib/visitIds.ts`) build the same id.
 */
const val VISIT_SESSION_PREFIX = "vis_"
/** The session id for a visit id. An id that already carries the prefix is left alone. */
fun sessionIdForVisit(visitId: String): String {
    val id = visitId.trim()
    return if (id.startsWith(VISIT_SESSION_PREFIX)) id else "$VISIT_SESSION_PREFIX$id"
}
/**
 * #2099: the console screen a notification's target opens. Open on a visit
 * notification used to land on the Bookings list with nothing selected: the
 * visit id on the notification was dropped. A visit now opens its own KinCare
 * detail, at every status it has a record for, and that screen says so in
 * plain words when the visit is gone ("This KinCare couldn't be found").
 * Admin web and admin Android already opened the visit.
 *
 * Only the four kinds of target a notification can carry, each with a real
 * id, name a screen; anything else opens nothing. Pure; unit-tested.
 */
sealed class NotificationTargetScreen {
    data class Invoice(val invoiceId: String) : NotificationTargetScreen()
    /** The KinTale report. */
    data class KinTale(val reportId: String) : NotificationTargetScreen()
    data class Household(val kinfolkId: String) : NotificationTargetScreen()
    /** The KinCare detail for a visit, by its session id. */
    data class Visit(val sessionId: String) : NotificationTargetScreen()
    /** An unknown kind of target, or one with no id. */
    data object None : NotificationTargetScreen()
}
fun notificationTargetScreen(targetType: String, targetId: String): NotificationTargetScreen {
    val id = targetId.trim()
    if (id.isEmpty()) return NotificationTargetScreen.None
    return when (targetType.trim().lowercase()) {
        "invoice" -> NotificationTargetScreen.Invoice(id)
        "kintale" -> NotificationTargetScreen.KinTale(id)
        "kinfolk" -> NotificationTargetScreen.Household(id)
        // #2367: an id with a slash, a `?` or the like names no visit; open nothing.
        "booking" -> if (isSafeNoticeId(id)) NotificationTargetScreen.Visit(sessionIdForVisit(id)) else NotificationTargetScreen.None
        else -> NotificationTargetScreen.None
    }
}
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

    /** #2367: a booking target whose ids fail [isSafeNoticeId]: Open goes nowhere. */
    data object None : NotificationOpenRoute()
}

private fun NotificationEntry.dataString(key: String): String =
    (data?.get(key) as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()

/**
 * The route for [entry]. Only `invoice.payment.unapplied` with a kinfolkId in
 * its data is overridden (its server targetType is `invoice`, but the decision
 * lives on the household); the notice's `stripeEventId` IS the paymentId. Every
 * other key keeps the targetType / targetId route. Pure; unit-tested.
 *
 * #2367: a whole-booking notice ([wholeBookingTarget]) opens Bookings on that
 * booking, the same place a `kincare.requested` row goes, checked before the
 * target table. A booking target whose ids fail [isSafeNoticeId] opens nothing.
 */
fun notificationOpenRoute(entry: NotificationEntry): NotificationOpenRoute {
    wholeBookingTarget(entry)?.let { (kinfolkId, batchId) ->
        return NotificationOpenRoute.VisitRequest(kinfolkId, batchId)
    }
    // A whole booking whose ids are not plain ids, or (#2398) that names no
    // household at all: never a route built from it. Its id is a request id,
    // so the visit route would only build `vis_{batchId}` and end on "This
    // KinCare couldn't be found". Admin web and admin Android offer no Open
    // for it either.
    if (isBatchTarget(entry)) {
        return NotificationOpenRoute.None
    }
    if (notificationRequestKey(entry) != null) {
        val kinfolkId = notificationRequestKinfolkId(entry)
        val batchId = entry.targetId.trim()
        if (!isSafeNoticeId(kinfolkId) || !isSafeNoticeId(batchId)) return NotificationOpenRoute.None
        return NotificationOpenRoute.VisitRequest(kinfolkId, batchId)
    }
    if (entry.targetType.trim().lowercase() == "booking" && !isSafeNoticeId(entry.targetId)) {
        return NotificationOpenRoute.None
    }
    if (entry.key.trim() == UNAPPLIED_PAYMENT_NOTICE_KEY) {
        val kinfolkId = entry.dataString("kinfolkId")
        if (kinfolkId.isNotEmpty()) {
            return NotificationOpenRoute.UnappliedPayment(kinfolkId, entry.dataString("stripeEventId").ifEmpty { null })
        }
    }
    return NotificationOpenRoute.Target(entry.targetType, entry.targetId)
}
/**
 * #1829: Open on an unread notice marks it read. The Unread tile counts notices
 * "not opened yet", and Open went to the right place but left the notice
 * unread, so the count never moved. [markRead] is started first and never
 * waited on: the Open goes ahead at once, and a failed mark is the caller's to
 * report. A read notice, or one with no id, opens without a write. Same rule as
 * admin web and admin Android.
 */
fun openNotification(
    entry: NotificationEntry,
    markRead: (notificationId: String) -> Unit,
    open: (NotificationEntry) -> Unit,
) {
    if (!entry.isRead && entry._id.isNotBlank()) markRead(entry._id)
    open(entry)
}
