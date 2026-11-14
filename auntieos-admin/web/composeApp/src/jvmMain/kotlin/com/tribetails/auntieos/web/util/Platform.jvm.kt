package com.tribetails.auntieos.web.util

import com.tribetails.auntieos.web.observability.runCatchingCancellable

actual fun openInMaps(address: String): Unit = throw UnsupportedOperationException("JVM stub")

// #2095: a real UTC instant with a `Z`, whole seconds, as web and Android
// stamp. It used to be the business's wall clock with no zone (#1155), which
// every reader then had to guess the zone of: the server's notice key read it
// as UTC (#2238), the Directory refused it as an instant. A zone-less value the
// console wrote before this still reads (`visitNoticeAtMs`, `timestampValueOf`).
actual fun nowIso(): String =
    java.time.Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString()

// The business's wall clock, for "today" and "this hour" on the console's
// screens (render paths call it during composition, so it must not throw).
// Formatted with the seconds always written: LocalDateTime.toString() drops
// them on a whole minute ("16:00"), which is not the documented shape.
actual fun businessNowLocalIso(): String =
    java.time.LocalDateTime.now(com.tribetails.auntieos.web.data.businessZoneId())
        .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss"))

actual fun businessTimeZoneId(): String = com.tribetails.auntieos.web.data.businessZoneId().id

// Desktop (JVM): open the URL in the system browser via AWT Desktop (mirrors
// platform/Launcher.jvm.kt). Fail-loud to stderr; headless/test JVMs without a
// Desktop log rather than crash, since this is a user-initiated convenience.
actual fun openUrl(url: String) {
    if (url.isBlank()) return
    runCatchingCancellable {
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
    runCatchingCancellable {
        val clip = java.awt.Toolkit.getDefaultToolkit().systemClipboard
        clip.setContents(java.awt.datatransfer.StringSelection(text), null)
    }
}

// Desktop (JVM): write the audio to a temp file and hand it to the OS default
// player. The name is reduced to letters and digits so a recording id can never
// steer the path. Fail-loud to stderr, like [openUrl]; the caller has already
// shown the operator a result for the fetch itself.
actual fun openAudioBytes(bytes: ByteArray, fileName: String) {
    if (bytes.isEmpty()) return
    runCatchingCancellable {
        val ext = fileName.substringAfterLast('.', "mp3").filter { it.isLetterOrDigit() }.ifBlank { "mp3" }
        val stem = fileName.substringBeforeLast('.').filter { it.isLetterOrDigit() }.ifBlank { "recording" }
        val file = java.io.File.createTempFile("auntieos-$stem-", ".$ext")
        file.deleteOnExit()
        file.writeBytes(bytes)
        val desktop = java.awt.Desktop.getDesktop()
        if (java.awt.Desktop.isDesktopSupported() && desktop.isSupported(java.awt.Desktop.Action.OPEN)) {
            desktop.open(file)
        } else {
            System.err.println("[AuntieOS] openAudioBytes unsupported on this desktop: ${file.absolutePath}")
        }
    }.onFailure { System.err.println("[AuntieOS] openAudioBytes failed for $fileName: ${it.message}") }
}
