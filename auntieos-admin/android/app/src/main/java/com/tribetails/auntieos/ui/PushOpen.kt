package com.tribetails.auntieos.ui

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.ui.admin.PENDING_BOOKING_REQUEST_KEY
import com.tribetails.auntieos.ui.admin.notificationKinfolkId
import com.tribetails.auntieos.ui.admin.unappliedPaymentNotice
import com.tribetails.auntieos.ui.admin.wholeBookingOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * #2100: WHAT A TAPPED PUSH OPENS, on the admin Android app.
 *
 * The messaging service has always put the push's key and route on the tap
 * intent, and MainActivity only handled call, voicemail and message taps, so a
 * push about a visit opened the app wherever it last was. The same notice
 * opened from the Notifications list did open the visit.
 *
 * A tap arrives in two shapes. A push that comes while the app is open goes
 * through the messaging service, which builds the tap intent. One that comes
 * while the app is closed or in the background never reaches the service:
 * Android shows it from the system tray and hands the launcher activity the
 * push's own data keys as extras. Both are read here into a
 * [NotificationEntry], the same thing a row of the Notifications list is, and
 * [pushOpenAction] sends it through the list's own Open rules. A tap on the
 * push and a tap on its row cannot land in two places.
 *
 * ONLY IN-APP SCREENS. Nothing a push carries is navigated as written. An id
 * fills one argument of a screen this app declares, and only when it is shaped
 * like an id ([pushId]): this app's routes are strings, and an id with a slash
 * or a question mark in it would name a different screen. The push's `route`
 * is a MyTribe web path and is never read here. Anything that cannot be placed
 * opens the Notifications list.
 *
 * ROLES. This app admits the owner only (`isOwnerClaims`); an Auntie's account
 * stops at "Admin access required" and the waiting tap is dropped there
 * ([PendingPushOpen.clear]). Money screens keep their own AdminGate on top.
 */

/** Data keys the server puts on a push (`notifications/noticeOpenTarget.ts`). */
internal const val PUSH_KEY_NOTIFICATION = "notificationKey"
internal const val PUSH_KEY_TARGET_TYPE = "targetType"
internal const val PUSH_KEY_TARGET_ID = "targetId"
internal const val PUSH_KEY_VISIT_ID = "visitId"
internal const val PUSH_KEY_BATCH_ID = "batchId"
internal const val PUSH_KEY_KINFOLK_ID = "kinfolkId"
internal const val PUSH_KEY_REQUEST_ID = "requestId"
internal const val PUSH_KEY_STRIPE_EVENT_ID = "stripeEventId"

/** The key the messaging service has always used for the catalog key on its own tap intent. */
internal const val PUSH_EXTRA_CATALOG_KEY = "CATALOG_KEY"

/** The older `booking_update` push stored only this. */
internal const val PUSH_EXTRA_BOOKING_ID = "bookingId"

/** The tap intent action the messaging service sets for a catalog push. */
internal const val PUSH_ACTION_OPEN_CATALOG = "com.tribetails.auntieos.OPEN_CATALOG_NOTIFICATION"

/** The data keys copied from a push onto its tap intent, and read back off it. */
internal val PUSH_TARGET_KEYS: List<String> = listOf(
    PUSH_KEY_TARGET_TYPE,
    PUSH_KEY_TARGET_ID,
    PUSH_KEY_VISIT_ID,
    PUSH_KEY_BATCH_ID,
    PUSH_KEY_KINFOLK_ID,
    PUSH_KEY_REQUEST_ID,
    PUSH_KEY_STRIPE_EVENT_ID,
)

/** Every extra [pushEntryFromIntent] reads, so the activity can drop them once read. */
internal val PUSH_OPEN_EXTRA_KEYS: List<String> =
    PUSH_TARGET_KEYS + listOf(PUSH_KEY_NOTIFICATION, PUSH_EXTRA_CATALOG_KEY, PUSH_EXTRA_BOOKING_ID)

private val PUSH_ID = Regex("^[A-Za-z0-9_.:~+-]{1,200}$")

/** [raw] when it is shaped like a record id, else "". An id never carries a path, a query or a space. */
internal fun pushId(raw: String?): String {
    val id = raw?.trim().orEmpty()
    return if (PUSH_ID.matches(id) && id != "." && id != "..") id else ""
}

private val PUSH_TARGET_TYPES = setOf("booking", "invoice", "kintale", "kinfolk")

/**
 * The notice a tap intent is about, or null when the intent is not a push tap
 * (a plain launch, a call or message tap). Pure; unit-tested.
 */
internal fun pushEntryFromIntent(action: String?, extras: Map<String, String?>): NotificationEntry? {
    fun text(k: String): String = extras[k]?.trim().orEmpty()
    val key = text(PUSH_KEY_NOTIFICATION).ifEmpty { text(PUSH_EXTRA_CATALOG_KEY) }
    val legacyBookingId = pushId(extras[PUSH_EXTRA_BOOKING_ID])
    val isPush = action == PUSH_ACTION_OPEN_CATALOG || key.isNotEmpty() || legacyBookingId.isNotEmpty()
    if (!isPush) return null

    val type = text(PUSH_KEY_TARGET_TYPE).lowercase()
    val known = type in PUSH_TARGET_TYPES
    val targetId = if (known) pushId(extras[PUSH_KEY_TARGET_ID]) else ""
    val data = buildMap<String, Any?> {
        for (k in listOf(PUSH_KEY_KINFOLK_ID, PUSH_KEY_REQUEST_ID, PUSH_KEY_STRIPE_EVENT_ID, PUSH_KEY_VISIT_ID, PUSH_KEY_BATCH_ID)) {
            val v = pushId(extras[k])
            if (v.isNotEmpty()) put(k, v)
        }
    }
    if (!known && legacyBookingId.isNotEmpty()) {
        return NotificationEntry(key = key, targetType = "booking", targetId = legacyBookingId, data = data)
    }
    return NotificationEntry(
        key = key,
        targetType = if (known && targetId.isNotEmpty()) type else "",
        targetId = targetId,
        data = data,
    )
}

/** Where a tapped push lands. */
internal sealed interface PushOpenAction {
    /** One of this app's own nav routes, built by [notificationOpenRoute]. */
    data class Route(val route: String) : PushOpenAction

    /**
     * #2028: a visit request opens its card on Bookings. #2367: so does any
     * whole booking; one no longer waiting shows its visits, highlighted, or
     * says it is no longer available.
     */
    data class VisitRequest(val kinfolkId: String, val batchId: String) : PushOpenAction

    /** #1003: the household profile, with that payment's Decide dialog. */
    data class UnappliedPayment(val kinfolkId: String, val paymentId: String, val route: String) : PushOpenAction

    /** Nothing this app can place: the Notifications list, where the notice itself is. */
    data object NotificationsList : PushOpenAction
}

/**
 * The Notifications list's Open, for a notice that arrived as a push. Same
 * order as the list: the visit request card, the unapplied payment, the Kin
 * removal request, then the target. Pure; unit-tested.
 *
 * A visit request opens its card whether or not it is still waiting. The list
 * can check the live queue first and a push cannot, and the card already says
 * when a request has been answered.
 */
internal fun pushOpenAction(entry: NotificationEntry): PushOpenAction {
    if (entry.key.trim() == PENDING_BOOKING_REQUEST_KEY && entry.targetType == "booking") {
        val kinfolkId = notificationKinfolkId(entry)
        val batchId = entry.targetId.trim()
        if (kinfolkId.isNotBlank() && batchId.isNotBlank()) return PushOpenAction.VisitRequest(kinfolkId, batchId)
    }
    // #2367: a push about a whole booking (its target is the booking's batch
    // id) opens Bookings on that booking, the place the request card is.
    wholeBookingOf(entry)?.let { (kinfolkId, batchId) -> return PushOpenAction.VisitRequest(kinfolkId, batchId) }
    val route = notificationOpenRoute(entry) ?: return PushOpenAction.NotificationsList
    val unapplied = unappliedPaymentNotice(entry)
    if (unapplied != null) return PushOpenAction.UnappliedPayment(unapplied.kinfolkId, unapplied.paymentId, route)
    return PushOpenAction.Route(route)
}

/**
 * The tap waiting to be opened. Held here, not on the intent, because it can
 * only open once the owner is signed in and the screens are mounted: a tap
 * while signed out waits through sign-in, and a tap while the app is running
 * is seen at once. Taken exactly once.
 */
internal object PendingPushOpen {
    private val state = MutableStateFlow<NotificationEntry?>(null)
    val pending: StateFlow<NotificationEntry?> = state

    /** A newer tap replaces an older one that never opened. */
    fun offer(entry: NotificationEntry) {
        state.value = entry
    }

    /** Hands back the waiting notice and forgets it, so it opens once. */
    fun take(): NotificationEntry? {
        val entry = state.value
        state.value = null
        return entry
    }

    /** Sign-out, or an account this app does not admit: the tap is dropped, not kept for the next sign-in. */
    fun clear() {
        state.value = null
    }
}
