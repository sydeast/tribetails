package com.kinfolk.portal.screens.invoices

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * #2401: THE WAY BACK INTO THIS APP FROM STRIPE.
 *
 * This app hands its card checkout to the phone's browser. Stripe used to send
 * that browser to the web portal's own invoice page, and a household who lives
 * in this app has usually never signed in to the web portal there, so the
 * first thing they saw after paying was a sign-in screen.
 *
 * Stripe now returns them to an address this app claims
 * ([APP_RETURN_HOST] + `/app/invoices/{id}`, see `AndroidManifest.xml`), so the
 * phone opens the app on the invoice. When the browser keeps the page instead,
 * the web portal shows a small signed-out page there whose button opens
 * `mytribe://invoices/{id}`, the same link in the app's own scheme.
 *
 * NOT the web portal's `/invoices/{id}`, on purpose. Claiming that address
 * would also pull the web portal's own return from Stripe, and every invoice
 * link in an email, out of the browser of anyone with this app installed.
 *
 * WHAT A RETURN LINK IS TRUSTED FOR: opening one invoice screen and starting
 * one read of the household's own invoices. Any app or web page can fire one,
 * so it never says paid: the read does. An id from another household finds
 * nothing, because every read goes through the signed-in session.
 */

/** The marker Stripe's success address carries. Exactly this value starts a check; anything else does not. */
internal const val CHECKOUT_RETURN_PARAM = "checkout"
internal const val CHECKOUT_RETURN_DONE = "done"

/** The one https host a return link may be on, and the app's own scheme. */
internal const val APP_RETURN_HOST = "kinfolk.tribetails.com"
internal const val APP_RETURN_SCHEME = "mytribe"

/**
 * What a return link says: which invoice, and whether Stripe finished the
 * checkout ([finished], the success address) or the household left it (the
 * cancel address).
 */
data class CheckoutReturn(val invoiceId: String, val finished: Boolean)

/** An id is one short token. Anything longer, or shaped like a path or an address, is not an id. */
private const val MAX_ID_LENGTH = 200

private fun invoiceIdOrNull(raw: String?): String? {
    val id = raw?.trim().orEmpty()
    if (id.isEmpty() || id.length > MAX_ID_LENGTH) return null
    if (id.any { it == '/' || it == '\\' || it == '?' || it == '#' || it.isWhitespace() || it.isISOControl() }) return null
    return id
}

/**
 * Reads a launch link as a checkout return, or null when it is not one.
 *
 * Pure, so it is tested without an Activity: [scheme], [host] and the decoded
 * [pathSegments] are the URI's parts, [checkout] its `checkout` query value.
 * Two shapes, and nothing else:
 *
 *   https://kinfolk.tribetails.com/app/invoices/{id}[?checkout=done]
 *   mytribe://invoices/{id}[?checkout=done]
 *
 * A path with anything before, between or after those parts is refused, so is
 * plain http, another host, and an id that is blank or shaped like a path. The
 * same discipline as a tapped push ([com.kinfolk.portal.push.pushTargetFromRoute]).
 */
fun checkoutReturnFromLink(
    scheme: String?,
    host: String?,
    pathSegments: List<String>,
    checkout: String?,
): CheckoutReturn? {
    val rawId = when {
        scheme == "https" && host == APP_RETURN_HOST ->
            if (pathSegments.size == 3 && pathSegments[0] == "app" && pathSegments[1] == "invoices") pathSegments[2] else null
        scheme == APP_RETURN_SCHEME && host == "invoices" ->
            if (pathSegments.size == 1) pathSegments[0] else null
        else -> null
    }
    val invoiceId = invoiceIdOrNull(rawId) ?: return null
    return CheckoutReturn(invoiceId = invoiceId, finished = checkout == CHECKOUT_RETURN_DONE)
}

/**
 * The return link waiting to be opened, and what the links have said so far.
 *
 * Held here, not on the intent, for the reason a tapped push is
 * ([com.kinfolk.portal.push.PendingPushOpen]): the invoice can only open once
 * the household is signed in and the shell is on screen. A link that arrives
 * while signed out waits through sign-in; one that arrives while the app is
 * running is seen at once. Taken exactly once.
 *
 * It never outlives the session it arrived in: signing out, or another person
 * signing in on the same phone, drops it ([onAccount]).
 */
object PendingCheckoutReturn {
    private val state = MutableStateFlow<CheckoutReturn?>(null)
    val pending: StateFlow<CheckoutReturn?> = state
    private var account: String? = null
    private var finished: String? = null
    private var cancelled: String? = null
    /** Told who is signed in, each time that is known for certain (null for a settled sign-out). */
    fun onAccount(uid: String?) {
        if (account != null && uid != account) clear()
        account = uid
    }
    /** Sign-out: nothing is kept for whoever signs in next. */
    fun clear() {
        state.value = null
        finished = null
        cancelled = null
    }
    /** A newer link replaces an older one that never opened. */
    fun offer(ret: CheckoutReturn) {
        state.value = ret
    }
    /** Hands back the waiting link and forgets it, so it opens once. */
    fun take(): CheckoutReturn? {
        val ret = state.value
        state.value = null
        return ret
    }
    /** True while a link for [invoiceId] is waiting to be opened. */
    fun isWaitingFor(invoiceId: String): Boolean = state.value?.invoiceId == invoiceId
    /*
     * WHAT THE LINKS HAVE SAID ABOUT A CHECKOUT, kept for the whole app and not
     * in one controller. Android can open a return link in a second window of
     * this app, stacked on the one the household paid from. The window
     * underneath still remembers handing the checkout off, and when the
     * household backs out to it, this is how it learns what the link said.
     *
     * The two answers are not equals. A FINISHED link is Stripe's success
     * address: the household paid, and the bill must be checked wherever it is
     * shown. A CANCELLED link only ever calls a wait OFF, so it is believed
     * only while no finished link has been seen for the same checkout. Any app
     * or web page can fire either link, and the worst a forged one may do is
     * cause a read. It must never be able to put a live Pay button in front of
     * a household whose payment is still landing.
     */
    /** A checkout for [invoiceId] is being handed to the browser: nothing an earlier link said answers for it. */
    fun handedOff(invoiceId: String) {
        if (finished == invoiceId) finished = null
        if (cancelled == invoiceId) cancelled = null
    }
    /** Stripe's success address came back for [invoiceId]. From here no cancel link is believed for it. */
    fun markFinished(invoiceId: String) {
        finished = invoiceId
        if (cancelled == invoiceId) cancelled = null
    }
    /**
     * Stripe's cancel address came back for [invoiceId]. Answers whether it is
     * believed: false when a finished link was already seen for this checkout.
     */
    fun markCancelled(invoiceId: String): Boolean {
        if (finished == invoiceId) return false
        cancelled = invoiceId
        return true
    }
    /** True when the checkout for [invoiceId] was cancelled and nothing since says it was paid. */
    fun wasCancelled(invoiceId: String): Boolean = cancelled == invoiceId && finished != invoiceId
}
