package com.tribetails.auntieos.web.platform

import com.tribetails.auntieos.web.observability.runCatchingCancellable
import java.awt.Desktop
import java.net.URI

actual fun launchUri(uri: String) {
    runCatchingCancellable {
        if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
            Desktop.getDesktop().browse(URI(uri))
        } else {
            System.err.println("[AuntieOS] launchUri unsupported on this desktop: $uri")
        }
    }.onFailure { System.err.println("[AuntieOS] launchUri failed for $uri: ${it.message}") }
}
