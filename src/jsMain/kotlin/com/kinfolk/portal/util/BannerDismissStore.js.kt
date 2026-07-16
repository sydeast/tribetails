package com.kinfolk.portal.util

import kotlinx.browser.localStorage
import org.w3c.dom.get
import org.w3c.dom.set

/** Web: persists per-device banner dismissals in localStorage. */
actual object BannerDismissStore {
    private fun key(id: String) = "dismissedBanner:$id"

    actual fun isDismissed(id: String): Boolean =
        id.isNotBlank() && localStorage[key(id)] != null

    actual fun dismiss(id: String) {
        if (id.isBlank()) return
        localStorage[key(id)] = "1"
    }
}
