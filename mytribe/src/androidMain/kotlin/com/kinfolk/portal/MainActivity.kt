package com.kinfolk.portal

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.kinfolk.portal.auth.parseEmailActionUrl
import com.kinfolk.portal.push.PUSH_OPEN_EXTRA_KEYS
import com.kinfolk.portal.push.PendingPushOpen
import com.kinfolk.portal.push.pushOpenFromExtras
import com.kinfolk.portal.screens.account.PendingCardSetupReturn
import com.kinfolk.portal.screens.invoices.PendingCheckoutReturn
import com.kinfolk.portal.ui.KinfolkPortalAppGuarded
import com.kinfolk.portal.util.androidInitialClaimInviteId
import com.kinfolk.portal.util.androidInitialSecureResetParams
import com.kinfolk.portal.util.androidInitialShareToken
import com.kinfolk.portal.util.androidInitialUnknownLink
import com.kinfolk.portal.util.cardSetupReturnOf
import com.kinfolk.portal.util.checkoutReturnOf
import com.kinfolk.portal.util.deepLinkIsRecognized
import com.kinfolk.portal.util.forgetEarlierLaunchLinks
import com.kinfolk.portal.util.launchLinkShouldBeRead

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // #2432: a launch link opens once. See launchLinkShouldBeRead.
        val replayed = intent != null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (launchLinkShouldBeRead(restored = savedInstanceState != null, replayedFromHistory = replayed)) {
            captureDeepLink(intent?.data)
        }
        // A restored activity is handed its first intent again; the tap it
        // carried was opened the first time round.
        if (savedInstanceState == null) {
            capturePushTap(intent)
            captureCheckoutReturn(intent)
            captureCardSetupReturn(intent)
        }
        setContent { KinfolkPortalAppGuarded() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        captureDeepLink(intent.data)
        capturePushTap(intent)
        captureCheckoutReturn(intent)
        captureCardSetupReturn(intent)
    }
    /**
     * #2427: Stripe sent the household back from its card page to an address
     * this app claims (`/app/account` on the portal host, or
     * `mytribe://account` from the portal's signed-out return page). Held for
     * the nav host, which opens Account Settings once the household is signed
     * in and reads the card again. Read once, like a card payment's return.
     */
    private fun captureCardSetupReturn(intent: Intent?) {
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val ret = cardSetupReturnOf(intent.data) ?: return
        PendingCardSetupReturn.offer(ret)
    }
    /**
     * #2401: Stripe sent the household back to an address this app claims
     * (`/app/invoices/<id>` on the portal host, or `mytribe://invoices/<id>`
     * from the portal's signed-out return page). It is read into a typed
     * return and held for the nav host, which opens that invoice once the
     * household is signed in and, after a finished checkout, has the bill
     * checked.
     *
     * Read once, like a push tap: a restored activity is handed its first
     * intent again, and so is one Android replays from Recents, and neither is
     * the household coming back from paying.
     */
    private fun captureCheckoutReturn(intent: Intent?) {
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val ret = checkoutReturnOf(intent.data) ?: return
        PendingCheckoutReturn.offer(ret)
    }
    /**
     * #2259: a tapped push opens what it is about. Two shapes arrive here: the
     * intent KinfolkFcmService builds for a push it showed itself, and, for a
     * push that came while the app was closed or in the background, the
     * launcher intent Android fills with the push's own data keys. Both are
     * read by [pushOpenFromExtras] into a typed target; the nav host opens it
     * once the household is signed in. The extras are dropped after reading,
     * and an intent Android replays from Recents is skipped, so the same tap
     * is never opened twice.
     */
    private fun capturePushTap(intent: Intent?) {
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val extras = intent.extras ?: return
        val read = PUSH_OPEN_EXTRA_KEYS.associateWith { key -> extras.getString(key) }
        val target = pushOpenFromExtras(read) ?: return
        PendingPushOpen.offer(target)
        PUSH_OPEN_EXTRA_KEYS.forEach { intent.removeExtra(it) }
    }

    private fun captureDeepLink(uri: Uri?) {
        if (uri == null) return
        val pathParts = uri.pathSegments ?: return
        // #2401: a card payment's return link names an invoice, and it is the
        // newest thing this app was asked to show. A claim, share or email
        // link from earlier in this run must not open in its place.
        val checkoutReturn = checkoutReturnOf(uri)
        // #2427: the same for a card setup coming back from Stripe.
        val cardSetupReturn = cardSetupReturnOf(uri)
        if (checkoutReturn != null || cardSetupReturn != null) forgetEarlierLaunchLinks()
        captureSegment(pathParts, "claim") { androidInitialClaimInviteId = it }
        // Invite emails link `${CLAIM_LINK_BASE_URL}?invite=<id>` (query form, no
        // path segment), so it must parse or the claim screen never mounts on Android.
        if (pathParts.lastOrNull() == "claim") {
            uri.getQueryParameter("invite")?.takeIf { it.isNotBlank() }?.let {
                androidInitialClaimInviteId = it
            }
        }
        captureSegment(pathParts, "share") { androidInitialShareToken = it }

        // #905: Firebase email action links, on the one action URL the project has
        // (https://kinfolk.tribetails.com/account/secure-reset, also /account/action).
        // Every mode arrives here and none carries an `email` param; the screen
        // reads the account from the verified code. Parsing is shared, and tested,
        // in commonMain.
        val emailAction = parseEmailActionUrl(uri.toString())
        emailAction?.let { androidInitialSecureResetParams = it }
        // #1293: a link the manifest let in that names nothing we can open lands on
        // the not-found screen instead of silently on Home.
        androidInitialUnknownLink = !deepLinkIsRecognized(
            // `mytribe://claim/<id>` carries "claim" as the host, not a path part.
            pathSegments = listOfNotNull(uri.host.takeIf { uri.scheme == "mytribe" }) + pathParts,
            inviteQuery = uri.getQueryParameter("invite"),
            isEmailAction = emailAction != null,
            // #2401: a card payment coming back is a link this app can place.
            isCheckoutReturn = checkoutReturn != null,
            // #2427: and so is a card setup coming back.
            isCardSetupReturn = cardSetupReturn != null,
        )
    }

    private inline fun captureSegment(parts: List<String>, prefix: String, store: (String) -> Unit) {
        val idx = parts.indexOf(prefix)
        if (idx >= 0 && idx + 1 < parts.size) {
            val id = parts[idx + 1]
            if (id.isNotBlank()) store(id)
        }
    }
}
