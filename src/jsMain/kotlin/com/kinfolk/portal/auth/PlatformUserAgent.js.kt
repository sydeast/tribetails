package com.kinfolk.portal.auth

import kotlinx.browser.window

actual fun platformUserAgent(): String =
    window.navigator.userAgent.takeIf { it.isNotBlank() } ?: "unknown-browser"
