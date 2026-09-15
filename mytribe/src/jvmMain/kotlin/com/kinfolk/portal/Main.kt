package com.kinfolk.portal

import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import com.kinfolk.portal.firebase.FirebaseRestConfig
import com.kinfolk.portal.ui.KinfolkPortalAppGuarded
import com.kinfolk.portal.util.SecureResetParams
import com.kinfolk.portal.util.jvmInitialClaimInviteId
import com.kinfolk.portal.util.jvmInitialSecureResetParams
import com.kinfolk.portal.util.jvmInitialShareToken

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

    // #889 review, item 3: a visible signal that this desktop session is
    // talking to a local Firebase emulator, not production, so an emulator
    // run left up in the background is never mistaken for the real app. The
    // jvm desktop target is not a delivery surface (mytribe/CLAUDE.md), so a
    // window-title suffix is the whole feature, not a placeholder for more.
    val windowTitle = if (FirebaseRestConfig.emulatorActive) "MyTribe [EMULATOR]" else "MyTribe"

    application {
        Window(onCloseRequest = ::exitApplication, title = windowTitle) {
            KinfolkPortalAppGuarded()
        }
    }
}
