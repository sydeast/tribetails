package com.kinfolk.portal.util

import android.net.Uri
import com.kinfolk.portal.screens.account.CARD_SETUP_RETURN_PARAM
import com.kinfolk.portal.screens.account.CardSetupReturn
import com.kinfolk.portal.screens.account.cardSetupReturnFromLink
import com.kinfolk.portal.screens.invoices.CHECKOUT_RETURN_PARAM
import com.kinfolk.portal.screens.invoices.CheckoutReturn
import com.kinfolk.portal.screens.invoices.checkoutReturnFromLink

/**
 * Android stores the latest deep-link invite id in this property.
 * MainActivity sets it from `intent.data` on create + new intent.
 */
@Volatile
internal var androidInitialClaimInviteId: String? = null

@Volatile
internal var androidInitialShareToken: String? = null

/**
 * #905: the Firebase email action link MainActivity was opened with
 * (`/account/secure-reset` or `/account/action` on kinfolk.tribetails.com), parsed by
 * [com.kinfolk.portal.auth.parseEmailActionUrl]. No `email` param is needed.
 */
@Volatile
internal var androidInitialSecureResetParams: SecureResetParams? = null

/** #1293: the launch link matched the manifest but named nothing the app can open. */
@Volatile
internal var androidInitialUnknownLink: Boolean = false
/**
 * #2401: a launch URI read as the address Stripe returns a card payment to, or
 * null when it is not one. The rules are [checkoutReturnFromLink]'s; this only
 * takes the URI apart. An opaque URI (`mytribe:invoices/x`, no `//`) has no
 * path parts and throws on a query read, so it is refused before either.
 */
internal fun checkoutReturnOf(uri: Uri?): CheckoutReturn? {
    if (uri == null || !uri.isHierarchical) return null
    return checkoutReturnFromLink(
        scheme = uri.scheme,
        host = uri.host,
        pathSegments = uri.pathSegments.orEmpty(),
        checkout = uri.getQueryParameter(CHECKOUT_RETURN_PARAM),
    )
}
/**
 * #2401: forgets the claim, share and email links this app was opened with
 * earlier in the same run.
 *
 * Those three are kept for the life of the process and are read again by every
 * new copy of the app's screen, where each of them wins over the signed-in
 * shell (`startRouteFor`). A card payment's return link can open such a copy.
 * Left alone, a household who had opened a shared KinTale link earlier would
 * come back from paying to that KinTale, and the invoice would never open.
 *
 * The return link is the newest thing the household asked this app to show,
 * so it replaces the older ones. A screen already drawn from one of them read
 * it when it was built and is not changed by this.
 */
internal fun forgetEarlierLaunchLinks() {
    androidInitialClaimInviteId = null
    androidInitialShareToken = null
    androidInitialSecureResetParams = null
}
/**
 * #2427: a launch URI read as the address Stripe returns a card setup to, or
 * null when it is not one. The rules are [cardSetupReturnFromLink]'s; this
 * only takes the URI apart, and refuses an opaque URI the way
 * [checkoutReturnOf] does.
 */
internal fun cardSetupReturnOf(uri: Uri?): CardSetupReturn? {
    if (uri == null || !uri.isHierarchical) return null
    return cardSetupReturnFromLink(
        scheme = uri.scheme,
        host = uri.host,
        pathSegments = uri.pathSegments.orEmpty(),
        billing = uri.getQueryParameter(CARD_SETUP_RETURN_PARAM),
    )
}
/**
 * #2432: A LAUNCH LINK OPENS ONCE.
 *
 * The claim, share and email links (and the not-found flag) live as long as
 * the process, and every new copy of the app's screen reads them and opens
 * them in place of the signed-in shell. Nothing cleared them, so a link opened
 * once came back when the household left with Back and opened the app from
 * its icon, and when a tapped push built the screen again.
 *
 * Called by `MainActivity.onCreate` before it reads its intent. Answers
 * whether that intent's link should be read.
 *
 * EVERY create starts with no launch link: whatever another screen was
 * opened with is forgotten. Then only this screen's own intent is read:
 *
 * - A fresh create reads its link, so a link that started it still opens, and
 *   a launcher or push intent with no link opens Home or the push's target.
 * - A RESTORED create (a configuration change the activity does not handle,
 *   such as dark mode or font size, or process death in the background) reads
 *   its own intent again, so a household still on the claim or reset screen
 *   stays there. A screen that was opened from the icon reads nothing, even
 *   when a second copy of the app on top of it had been opened by a link.
 * - A create Android REPLAYED from Recents carries the intent the task was
 *   first opened with. That link was opened the first time round, so it is
 *   not read, fresh or restored (the push tap and the card returns skip it
 *   the same way).
 *
 * [restored] is kept as an input so the call site states both facts; the
 * answer does not depend on it.
 */
internal fun launchLinkShouldBeRead(@Suppress("UNUSED_PARAMETER") restored: Boolean, replayedFromHistory: Boolean): Boolean {
    forgetEarlierLaunchLinks()
    androidInitialUnknownLink = false
    return !replayedFromHistory
}
actual fun readInitialClaimInviteId(): String? = androidInitialClaimInviteId
actual fun readInitialShareToken(): String? = androidInitialShareToken
actual fun readInitialSecureResetParams(): SecureResetParams? = androidInitialSecureResetParams
actual fun readInitialUnknownLink(): Boolean = androidInitialUnknownLink
