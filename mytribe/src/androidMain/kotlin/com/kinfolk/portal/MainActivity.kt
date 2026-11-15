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
import com.kinfolk.portal.ui.KinfolkPortalAppGuarded
import com.kinfolk.portal.util.androidInitialClaimInviteId
import com.kinfolk.portal.util.androidInitialSecureResetParams
import com.kinfolk.portal.util.androidInitialShareToken
import com.kinfolk.portal.util.androidInitialUnknownLink
import com.kinfolk.portal.util.deepLinkIsRecognized

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureDeepLink(intent?.data)
        // A restored activity is handed its first intent again; the tap it
        // carried was opened the first time round.
        if (savedInstanceState == null) capturePushTap(intent)
        setContent { KinfolkPortalAppGuarded() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        captureDeepLink(intent.data)
        capturePushTap(intent)
    }
    /**
     * #2259: a tapped push opens what it is about. Two shapes arrive here: the
     * intent KinfolkFcmService builds for a push it showed itself, and, for a
     * push that came while the app was closed or in the background, the
     * launcher intent Android fills with the push's own data keys. Both are
     * read by [pushOpenFromExtras] into a typed target; the nav host opens it
     * once the household is signed in. The extras are dropped after reading,
     * so the same tap is never read twice.
     */
    private fun capturePushTap(intent: Intent?) {
        val extras = intent?.extras ?: return
        val read = PUSH_OPEN_EXTRA_KEYS.associateWith { key -> extras.getString(key) }
        val target = pushOpenFromExtras(read) ?: return
        PendingPushOpen.offer(target)
        PUSH_OPEN_EXTRA_KEYS.forEach { intent.removeExtra(it) }
    }

    private fun captureDeepLink(uri: Uri?) {
        if (uri == null) return
        val pathParts = uri.pathSegments ?: return
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
