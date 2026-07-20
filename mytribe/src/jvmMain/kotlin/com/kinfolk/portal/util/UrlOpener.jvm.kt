package com.kinfolk.portal.util

import java.awt.Desktop
import java.net.URI

actual fun openExternalUrl(url: String) {
    try {
        if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
            Desktop.getDesktop().browse(URI(url))
        }
    } catch (_: Throwable) {
        // best-effort; nothing else to do on JVM desktop
    }
}
