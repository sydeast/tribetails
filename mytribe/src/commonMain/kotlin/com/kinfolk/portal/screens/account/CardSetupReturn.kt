package com.kinfolk.portal.screens.account

import com.kinfolk.portal.screens.invoices.APP_RETURN_HOST
import com.kinfolk.portal.screens.invoices.APP_RETURN_SCHEME
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * #2427: THE WAY BACK INTO THIS APP FROM STRIPE'S CARD PAGE.
 *
 * "Add a card" and "Replace card" hand the household to Stripe in the phone's
 * browser. Stripe used to send that browser to the web portal's own Account
 * page (`/account?billing=saved`), which needs a web sign-in. A household who
 * lives in this app has usually never signed in to the web portal there, so
 * the first thing they saw after saving a card was the MyTribe sign-in page.
 *
 * Stripe now returns them to an address this app claims
 * (`https://kinfolk.tribetails.com/app/account`, see `AndroidManifest.xml`),
 * the same pattern #2401 set up for a card payment. The phone opens the app on
 * Account Settings and the card on file is read again. When the browser keeps
 * the page instead, the web portal shows a signed-out page there whose button
 * opens `mytribe://account`, the same link in the app's own scheme.
 *
 * NOT the web portal's `/account`, on purpose: claiming it would pull the web
 * portal's own return from Stripe, and the email action links under
 * `/account/`, out of the browser of anyone with this app installed.
 *
 * WHAT A RETURN LINK IS TRUSTED FOR: opening Account Settings and starting one
 * read of the household's own card. Any app or web page can fire one, so it
 * never says a card was saved: the read does.
 */

/** The marker Stripe's success address carries. */
internal const val CARD_SETUP_RETURN_PARAM = "billing"
internal const val CARD_SETUP_RETURN_SAVED = "saved"

/** The two addresses this app gives Stripe for a card setup: (success, cancel). */
internal fun cardSetupReturnUrls(): Pair<String, String> {
    val page = "https://$APP_RETURN_HOST/app/account"
    return "$page?$CARD_SETUP_RETURN_PARAM=$CARD_SETUP_RETURN_SAVED" to page
}

/** What a return link says: whether Stripe finished the card setup ([saved]) or the household left it. */
data class CardSetupReturn(val saved: Boolean)

/**
 * Reads a launch link as a card-setup return, or null when it is not one.
 * Pure, so it is tested without an Activity. Two shapes, and nothing else:
 *
 *   https://kinfolk.tribetails.com/app/account[?billing=saved]
 *   mytribe://account[?billing=saved]
 *
 * Anything before or after those parts, plain http and another host are all
 * refused, the same discipline as
 * [com.kinfolk.portal.screens.invoices.checkoutReturnFromLink].
 */
fun cardSetupReturnFromLink(
    scheme: String?,
    host: String?,
    pathSegments: List<String>,
    billing: String?,
): CardSetupReturn? {
    val matches = when {
        scheme == "https" && host == APP_RETURN_HOST -> pathSegments == listOf("app", "account")
        scheme == APP_RETURN_SCHEME && host == "account" -> pathSegments.isEmpty()
        else -> false
    }
    if (!matches) return null
    return CardSetupReturn(saved = billing == CARD_SETUP_RETURN_SAVED)
}

/**
 * The return link waiting to be opened. Held here, not on the intent, for the
 * reason a card payment's return is
 * ([com.kinfolk.portal.screens.invoices.PendingCheckoutReturn]): Account
 * Settings can only open once the household is signed in and the shell is on
 * screen. Taken exactly once, and never kept past the session it arrived in.
 */
object PendingCardSetupReturn {
    private val state = MutableStateFlow<CardSetupReturn?>(null)
    val pending: StateFlow<CardSetupReturn?> = state
    private var account: String? = null
    /** Told who is signed in, each time that is known for certain (null for a settled sign-out). */
    fun onAccount(uid: String?) {
        if (account != null && uid != account) clear()
        account = uid
    }
    /** Sign-out: nothing is kept for whoever signs in next. */
    fun clear() {
        state.value = null
    }
    /** A newer link replaces an older one that never opened. */
    fun offer(ret: CardSetupReturn) {
        state.value = ret
    }
    /** Hands back the waiting link and forgets it, so it opens once. */
    fun take(): CardSetupReturn? {
        val ret = state.value
        state.value = null
        return ret
    }
}
