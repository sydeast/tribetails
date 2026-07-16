package com.tribetails.auntieos.web

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.ComposeViewport
import kotlinx.browser.document

@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    // Optional: hide the host page's "Loading…" splash once Compose paints.
    document.getElementById("loading")?.remove()

    // ComposeViewport (CMP 1.8) replaces the deprecated CanvasBasedWindow and builds
    // its own <canvas> inside the given container element.
    // NOTE: the web "can't type in any text field" bug was NOT caused by the window
    // API. Real cause was a modifier-ORDER bug in BottomBorderField / AuntiePasswordField
    // (focusProperties{canFocus=false} placed AFTER .clickable cascaded onto the child
    // BasicTextField); fixed by moving focusProperties BEFORE .clickable. No Compose/
    // Kotlin upgrade was needed.
    ComposeViewport(viewportContainerId = "auntieosCanvas") {
        App()
    }
}
