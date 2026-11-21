package com.kinfolk.portal

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.kinfolk.portal.push.PUSH_OPEN_EXTRA_KEYS
import com.kinfolk.portal.push.PendingPushOpen
import com.kinfolk.portal.push.pushOpenFromExtras
import com.kinfolk.portal.screens.account.PendingCardSetupReturn
import com.kinfolk.portal.screens.invoices.PendingCheckoutReturn
import com.kinfolk.portal.ui.KinfolkPortalAppGuarded
import com.kinfolk.portal.util.captureLaunchLink
import com.kinfolk.portal.util.cardSetupReturnOf
import com.kinfolk.portal.util.checkoutReturnOf
import com.kinfolk.portal.util.readLaunchLinkOnCreate

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // #2432: a launch link opens once. See launchLinkShouldBeRead.
        readLaunchLinkOnCreate(intent, restored = savedInstanceState != null)
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
        captureLaunchLink(intent.data)
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
}
