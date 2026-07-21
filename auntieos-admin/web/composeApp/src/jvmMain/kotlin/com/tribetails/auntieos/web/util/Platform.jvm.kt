package com.tribetails.auntieos.web.util

actual fun openInMaps(address: String): Unit = throw UnsupportedOperationException("JVM stub")
// Real impl: render paths (e.g. the Auntie Time day-of filter) call nowIso() during
// composition, so it must return a usable ISO-8601 timestamp, not throw. Seconds precision.
actual fun nowIso(): String =
    java.time.LocalDateTime.now().withNano(0).toString()
// Desktop (JVM): open the URL in the system browser via AWT Desktop (mirrors
// platform/Launcher.jvm.kt). Fail-loud to stderr; headless/test JVMs without a
// Desktop log rather than crash, since this is a user-initiated convenience.
actual fun openUrl(url: String) {
    if (url.isBlank()) return
    runCatching {
        val desktop = java.awt.Desktop.getDesktop()
        if (java.awt.Desktop.isDesktopSupported() && desktop.isSupported(java.awt.Desktop.Action.BROWSE)) {
            desktop.browse(java.net.URI(url))
        } else {
            System.err.println("[AuntieOS] openUrl unsupported on this desktop: $url")
        }
    }.onFailure { System.err.println("[AuntieOS] openUrl failed for $url: ${it.message}") }
}

actual fun copyToClipboard(text: String) {
    if (text.isBlank()) return
    // Desktop (JVM): real AWT clipboard. Headless / test JVMs throw, which we
    // swallow because the share dialog still SHOWS the URL (clipboard is a
    // best-effort convenience, never the only way to read the link).
    runCatching {
        val clip = java.awt.Toolkit.getDefaultToolkit().systemClipboard
        clip.setContents(java.awt.datatransfer.StringSelection(text), null)
    }
}
