package com.kinfolk.portal.push

import com.kinfolk.portal.nav.BookingEnvelopeRoute
import com.kinfolk.portal.nav.InvoiceDetailRoute
import com.kinfolk.portal.nav.KinCareDetailRoute
import com.kinfolk.portal.nav.KinDetailRoute
import com.kinfolk.portal.nav.KinRoute
import com.kinfolk.portal.nav.KinTalesRoute
import com.kinfolk.portal.nav.MessageAuntieRoute
import com.kinfolk.portal.nav.NotificationsListRoute
import com.kinfolk.portal.nav.ScheduleRoute
import com.kinfolk.portal.nav.TribeRoute
import com.kinfolk.portal.portal.NotificationTarget
import com.kinfolk.portal.portal.notificationTargetFor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * #2259: WHAT A TAPPED PUSH OPENS, on the portal Android app.
 *
 * The messaging service has always put the push's route on the tap intent, and
 * nothing read it, so a tap opened the app wherever it last was. Two more
 * things were wrong underneath. A push that arrives while the app is closed or
 * in the background never reaches the messaging service at all: Android shows
 * it from the system tray and hands the launcher activity the push's own data
 * keys as intent extras. And a route is a web path, which this app does not
 * navigate by.
 *
 * So the tap is read here, from either shape, into the SAME typed target the
 * notifications list opens ([NotificationTarget]), and the nav host turns that
 * into one of its own destinations. Nothing a push carries is ever handed to
 * the navigator as text: an id fills an argument of a destination this app
 * declares, and a path this file does not list opens the notifications list.
 * A link to a web page or to another app has nowhere to go.
 *
 * The household's own records are the only ones that open: every screen reads
 * through the signed-in session, so an id from another household finds
 * nothing and the screen says so.
 */

/** Data keys the server puts on a push (`notifications/noticeOpenTarget.ts`). */
const val PUSH_KEY_NOTIFICATION = "notificationKey"
const val PUSH_KEY_ROUTE = "route"
const val PUSH_KEY_TARGET_TYPE = "targetType"
const val PUSH_KEY_TARGET_ID = "targetId"
const val PUSH_KEY_VISIT_ID = "visitId"
const val PUSH_KEY_BATCH_ID = "batchId"

/** The keys [KinfolkFcmService] has always used on its own tap intent. */
const val PUSH_EXTRA_CATALOG_KEY = "CATALOG_KEY"
const val PUSH_EXTRA_CATALOG_ROUTE = "CATALOG_ROUTE"

/** Every extra a tap intent may carry that [pushOpenFromExtras] reads. */
val PUSH_OPEN_EXTRA_KEYS: List<String> = listOf(
    PUSH_KEY_NOTIFICATION,
    PUSH_KEY_ROUTE,
    PUSH_KEY_TARGET_TYPE,
    PUSH_KEY_TARGET_ID,
    PUSH_KEY_VISIT_ID,
    PUSH_KEY_BATCH_ID,
    PUSH_EXTRA_CATALOG_KEY,
    PUSH_EXTRA_CATALOG_ROUTE,
)

/** An id is one short token. Anything longer, or shaped like a path or an address, is not an id. */
private const val MAX_ID_LENGTH = 200

private fun idOrBlank(raw: String?): String {
    val id = raw?.trim().orEmpty()
    if (id.isEmpty() || id.length > MAX_ID_LENGTH) return ""
    if (id.any { it == '/' || it == '\\' || it == '?' || it == '#' || it.isWhitespace() || it.isISOControl() }) return ""
    return id
}

/** `%2F`-style escapes undone, or null when the text is not a clean escape sequence. */
private fun percentDecoded(raw: String): String? {
    if ('%' !in raw) return raw
    val bytes = ArrayList<Byte>(raw.length)
    var i = 0
    while (i < raw.length) {
        val c = raw[i]
        if (c == '%') {
            if (i + 2 >= raw.length) return null
            val v = raw.substring(i + 1, i + 3).toIntOrNull(16) ?: return null
            bytes.add(v.toByte())
            i += 3
        } else {
            if (c.code > 0x7f) return null
            bytes.add(c.code.toByte())
            i += 1
        }
    }
    return runCatching { bytes.toByteArray().decodeToString(throwOnInvalidSequence = true) }.getOrNull()
}

/**
 * The target a MyTribe web path names, or null for a path this app has no
 * screen for. The closed list of paths the server builds
 * (`householdRouteFor`, and the notifications list at one entry), nothing else: `/schedule/book` and `/kin/new` are
 * web pages, not ids; an absolute address, `//host`, a backslash, a second
 * path part or an unknown query key is refused.
 */
fun pushTargetFromRoute(route: String?): NotificationTarget? {
    val raw = route?.trim().orEmpty()
    if (raw.isEmpty() || !raw.startsWith("/") || raw.startsWith("//")) return null
    if (raw.any { it == '\\' || it == '#' || it.isWhitespace() || it.isISOControl() }) return null
    val path = raw.substringBefore('?')
    val query = if ('?' in raw) raw.substringAfter('?') else null
    val parts = path.trim('/').split('/').filter { it.isNotEmpty() }
    if (path != "/" + parts.joinToString("/")) return null

    fun id(part: String): String = idOrBlank(percentDecoded(part))
    if (parts.firstOrNull() == "kintales" && parts.size == 1) {
        if (query == null) return NotificationTarget.KinTales
        val pairs = query.split('&')
        if (pairs.size != 1 || !pairs[0].startsWith("tale=")) return null
        val taleId = id(pairs[0].removePrefix("tale="))
        return if (taleId.isEmpty()) null else NotificationTarget.KinTale(taleId)
    }
    // The notifications list at one entry: where a household reads the whole
    // of a push that was cut, or that carries the office's note.
    if (parts.firstOrNull() == "notifications" && parts.size == 1 && query != null) {
        val pairs = query.split('&')
        if (pairs.size != 1 || !pairs[0].startsWith("entry=")) return null
        val entryId = id(pairs[0].removePrefix("entry="))
        return if (entryId.isEmpty()) null else NotificationTarget.Entry(entryId)
    }
    if (query != null) return null
    return when (parts.size) {
        1 -> when (parts[0]) {
            "schedule" -> NotificationTarget.Schedule
            "kin" -> NotificationTarget.KinList
            "tribe" -> NotificationTarget.Household
            "messages" -> NotificationTarget.Messages
            "notifications" -> NotificationTarget.None
            else -> null
        }
        2 -> {
            val second = id(parts[1])
            if (second.isEmpty()) return null
            when (parts[0]) {
                "schedule" -> if (second == "book") null else NotificationTarget.Visit(second, null)
                "invoices" -> NotificationTarget.Invoice(second)
                "kin" -> if (second == "new") null else NotificationTarget.Kin(second)
                else -> null
            }
        }
        // #1865: a whole booking request, the path `householdRouteFor` builds for it.
        3 -> {
            val batchId = id(parts[2])
            if (parts[0] == "schedule" && parts[1] == "booking" && batchId.isNotEmpty()) {
                NotificationTarget.BookingRequest(batchId)
            } else {
                null
            }
        }
        else -> null
    }
}

/**
 * What a tap intent's extras open, or null when the intent is not a push tap
 * (a plain launch, an App Link). [NotificationTarget.None] is a push that
 * names nothing this app can open: it lands on the notifications list.
 *
 * The target fields win, because they say more than a path can (the booking
 * request a whole-request notice is about). A push with a route and no target
 * fields is read through [pushTargetFromRoute].
 */
fun pushOpenFromExtras(extras: Map<String, String?>): NotificationTarget? {
    fun text(k: String): String = extras[k]?.trim().orEmpty()
    val isPush = text(PUSH_KEY_NOTIFICATION).isNotEmpty() || text(PUSH_EXTRA_CATALOG_KEY).isNotEmpty()
    if (!isPush) return null

    val targetType = text(PUSH_KEY_TARGET_TYPE)
    if (targetType.isNotEmpty()) {
        return notificationTargetFor(
            targetType = targetType,
            targetId = idOrBlank(extras[PUSH_KEY_TARGET_ID]),
            visitId = idOrBlank(extras[PUSH_KEY_VISIT_ID]),
            batchId = idOrBlank(extras[PUSH_KEY_BATCH_ID]),
        )
    }
    val route = text(PUSH_KEY_ROUTE).ifEmpty { text(PUSH_EXTRA_CATALOG_ROUTE) }
    return pushTargetFromRoute(route) ?: NotificationTarget.None
}

/**
 * The nav destination for a target: always one this app declares. The same
 * destinations the notifications list navigates to for the same target.
 */
fun pushOpenDestination(target: NotificationTarget): Any = when (target) {
    is NotificationTarget.Visit -> KinCareDetailRoute(target.batchId, target.visitId)
    is NotificationTarget.BookingRequest -> BookingEnvelopeRoute(target.batchId)
    NotificationTarget.Schedule -> ScheduleRoute
    is NotificationTarget.Invoice -> InvoiceDetailRoute(target.invoiceId)
    is NotificationTarget.KinTale -> KinTalesRoute(target.taleId)
    NotificationTarget.KinTales -> KinTalesRoute()
    is NotificationTarget.Kin -> KinDetailRoute(target.kinId)
    NotificationTarget.KinList -> KinRoute
    NotificationTarget.Household -> TribeRoute
    NotificationTarget.Messages -> MessageAuntieRoute
    // The list; the nav host hands it the entry to show.
    is NotificationTarget.Entry -> NotificationsListRoute
    NotificationTarget.None -> NotificationsListRoute
}

/**
 * The tap waiting to be opened. Held here, not on the intent, because the
 * target can only open once the household is signed in and the shell is on
 * screen: a tap while signed out waits through sign-in, and a tap while the
 * app is already running is seen at once. Taken exactly once.
 *
 * A tap never outlives the session it was made in: signing out, or another
 * person signing in on the same phone, drops it ([onAccount]). A tap made
 * while nobody is signed in is kept for the sign-in that follows it.
 */
object PendingPushOpen {
    private val state = MutableStateFlow<NotificationTarget?>(null)
    val pending: StateFlow<NotificationTarget?> = state
    private var account: String? = null
    /**
     * Told who is signed in, each time that is known for certain (null for a
     * settled sign-out). Leaving an account, by signing out or by a different
     * one taking its place, drops the waiting tap. Never called while the app
     * is still finding out: a tap restarts the screen, and the tap it carried
     * has to outlast that.
     */
    fun onAccount(uid: String?) {
        if (account != null && uid != account) state.value = null
        account = uid
    }
    /** Sign-out: the tap is dropped, not kept for whoever signs in next. */
    fun clear() {
        state.value = null
    }

    /** A newer tap replaces an older one that never opened. */
    fun offer(target: NotificationTarget) {
        state.value = target
    }

    /** Hands back the waiting target and forgets it, so it opens once. */
    fun take(): NotificationTarget? {
        val target = state.value
        state.value = null
        return target
    }
}
