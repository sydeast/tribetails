package com.kinfolk.portal

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.kinfolk.portal.ui.KinfolkPortalAppGuarded
import com.kinfolk.portal.util.SecureResetParams
import com.kinfolk.portal.util.androidInitialClaimInviteId
import com.kinfolk.portal.util.androidInitialSecureResetParams
import com.kinfolk.portal.util.androidInitialShareToken

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        captureDeepLink(intent?.data)
        setContent { KinfolkPortalAppGuarded() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        captureDeepLink(intent.data)
    }

    private fun captureDeepLink(uri: Uri?) {
        if (uri == null) return
        val pathParts = uri.pathSegments ?: return
        captureSegment(pathParts, "claim") { androidInitialClaimInviteId = it }
        // Invite emails link `${CLAIM_LINK_BASE_URL}?invite=<id>` (query form, no
        // path segment) — must parse or the claim screen never mounts on Android.
        if (pathParts.lastOrNull() == "claim") {
            uri.getQueryParameter("invite")?.takeIf { it.isNotBlank() }?.let {
                androidInitialClaimInviteId = it
            }
        }
        captureSegment(pathParts, "share") { androidInitialShareToken = it }

        // /account/secure-reset?oobCode=<code>&email=<email>
        // Firebase appends email via continueUrl when ActionCodeSettings.url is set.
        if (pathParts.size >= 2 && pathParts[pathParts.size - 2] == "account" &&
            pathParts[pathParts.size - 1] == "secure-reset"
        ) {
            val oobCode = uri.getQueryParameter("oobCode")?.takeIf { it.isNotBlank() }
            val email = uri.getQueryParameter("email")?.takeIf { it.isNotBlank() }
                ?: uri.getQueryParameter("continueUrl")
                    ?.takeIf { it.isNotBlank() }
                    ?.let { continueUrl ->
                        Uri.parse(continueUrl).getQueryParameter("email")?.takeIf { it.isNotBlank() }
                    }
            if (oobCode != null && email != null) {
                androidInitialSecureResetParams = SecureResetParams(oobCode = oobCode, email = email)
            }
        }
    }

    private inline fun captureSegment(parts: List<String>, prefix: String, store: (String) -> Unit) {
        val idx = parts.indexOf(prefix)
        if (idx >= 0 && idx + 1 < parts.size) {
            val id = parts[idx + 1]
            if (id.isNotBlank()) store(id)
        }
    }
}
