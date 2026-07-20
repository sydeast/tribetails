package com.kinfolk.portal.util

import kotlinx.browser.window

actual fun openExternalUrl(url: String) {
    window.open(url, "_blank")
}
