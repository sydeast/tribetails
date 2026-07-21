package com.tribetails.auntieos.web.ui.shell

import kotlinx.browser.window

actual fun currentHash(): String = window.location.hash

actual fun setHash(value: String) {
    // Avoid redundant writes that would re-trigger a hashchange loop.
    if (window.location.hash != value) window.location.hash = value
}

actual fun observeHash(onChange: (String) -> Unit) {
    window.addEventListener("hashchange", { onChange(window.location.hash) })
}
