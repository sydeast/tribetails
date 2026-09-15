package com.kinfolk.portal

import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import com.kinfolk.portal.firebase.FirebaseRestConfig
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

fun main(args: Array<String>) {
    args.firstOrNull { it.startsWith("--claim=") }
        ?.removePrefix("--claim=")
        ?.takeIf { it.isNotBlank() }
        ?.let { jvmInitialClaimInviteId = it }
    args.firstOrNull { it.startsWith("--share=") }
        ?.removePrefix("--share=")
        ?.takeIf { it.isNotBlank() }
        ?.let { jvmInitialShareToken = it }

    // --secure-reset-oob=<oobCode> --secure-reset-email=<email>
    val oob = args.firstOrNull { it.startsWith("--secure-reset-oob=") }
        ?.removePrefix("--secure-reset-oob=")
        ?.takeIf { it.isNotBlank() }
    val srEmail = args.firstOrNull { it.startsWith("--secure-reset-email=") }
        ?.removePrefix("--secure-reset-email=")
        ?.takeIf { it.isNotBlank() }
    if (oob != null && srEmail != null) {
        jvmInitialSecureResetParams = SecureResetParams(oobCode = oob, email = srEmail)
    }

    application {
        Window(onCloseRequest = ::exitApplication, title = windowTitle(FirebaseRestConfig)) {
            KinfolkPortalAppGuarded()
        }
    }
}
