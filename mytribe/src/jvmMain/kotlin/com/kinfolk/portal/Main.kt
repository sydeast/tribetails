package com.kinfolk.portal

import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import com.kinfolk.portal.firebase.FirebaseRestConfig
import com.kinfolk.portal.auth.parseEmailActionUrl
import com.kinfolk.portal.firebase.RestEndpoints
import com.kinfolk.portal.ui.KinfolkPortalAppGuarded
import com.kinfolk.portal.util.SecureResetParams
import com.kinfolk.portal.util.jvmInitialClaimInviteId
import com.kinfolk.portal.util.jvmInitialSecureResetParams
import com.kinfolk.portal.util.jvmInitialShareToken

/**
 * #889 review, item 3: a visible signal that this desktop session is talking
 * to a local Firebase emulator, not production, so an emulator run left up
 * in the background is never mistaken for the real app. The jvm desktop
 * target is not a delivery surface (mytribe/CLAUDE.md), so a window-title
 * suffix is the whole feature, not a placeholder for more.
 *
 * #889 review round 3, item 7: a rejected emulator switch only ever warned
 * on stderr, which a desktop app launched from Finder never shows anyone.
 * When nothing is active but at least one switch was set and rejected
 * (RestEndpoints.emulatorConfigRejected), the title says so instead of
 * staying silently plain.
 *
 * Extracted from main() and takes [endpoints] as a parameter, not read from
 * FirebaseRestConfig directly, so a test can inject a fake and assert the
 * title without touching process environment variables.
 */
internal fun windowTitle(endpoints: RestEndpoints): String = when {
    endpoints.emulatorActive -> "MyTribe [EMULATOR]"
    endpoints.emulatorConfigRejected -> "MyTribe [Emulator setting ignored]"
    else -> "MyTribe"
}

/**
 * The Firebase email action link this desktop session was started with (#905).
 *
 * Desktop has no link handler, so a link arrives as an argument:
 *
 * - `--email-link=<the whole https URL from the email>` is the shape to use. It
 *   goes through the same [parseEmailActionUrl] the Android app and the Kotlin/JS
 *   portal use, so every mode and the continue target come across.
 * - `--secure-reset-oob=<code>` is the older shape, kept working. It no longer
 *   needs `--secure-reset-email=`: the account comes from the verified code, and
 *   an address in the argument was never checked against it. Any
 *   `--secure-reset-email=` still passed is ignored.
 *
 * Either way the screen lands on the same page and the same contract as web
 * and Android. What desktop cannot do is check the code: its REST auth backend
 * has no `checkActionCode`, so [com.kinfolk.portal.auth.AuthBackend]'s default
 * throws and the screen shows "Open this link in a web browser" with the link
 * on the portal page. No password is set here and no incident is filed.
 */
internal fun emailActionArg(args: Array<String>): SecureResetParams? {
    args.firstOrNull { it.startsWith("--email-link=") }
        ?.removePrefix("--email-link=")
        ?.takeIf { it.isNotBlank() }
        ?.let { return parseEmailActionUrl(it) }
    return args.firstOrNull { it.startsWith("--secure-reset-oob=") }
        ?.removePrefix("--secure-reset-oob=")
        ?.takeIf { it.isNotBlank() }
        ?.let { SecureResetParams(oobCode = it) }
}

fun main(args: Array<String>) {
    args.firstOrNull { it.startsWith("--claim=") }
        ?.removePrefix("--claim=")
        ?.takeIf { it.isNotBlank() }
        ?.let { jvmInitialClaimInviteId = it }
    args.firstOrNull { it.startsWith("--share=") }
        ?.removePrefix("--share=")
        ?.takeIf { it.isNotBlank() }
        ?.let { jvmInitialShareToken = it }

    emailActionArg(args)?.let { jvmInitialSecureResetParams = it }

    application {
        Window(onCloseRequest = ::exitApplication, title = windowTitle(FirebaseRestConfig)) {
            KinfolkPortalAppGuarded()
        }
    }
}
