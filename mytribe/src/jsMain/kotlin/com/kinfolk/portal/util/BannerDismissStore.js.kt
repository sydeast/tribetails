package com.kinfolk.portal.util

import kotlinx.browser.localStorage
import org.w3c.dom.get
import org.w3c.dom.set

internal actual fun deviceBannerDismissals(): BannerDismissals = LocalStorageBannerDismissals

/** Web: localStorage under `dismissedBanner:{id}`, the key the web portal has always written. */
private object LocalStorageBannerDismissals : BannerDismissals {
    private const val PREFIX = "dismissedBanner:"

    override fun isDismissed(id: String): Boolean = localStorage[PREFIX + id] != null

    override fun dismiss(id: String) {
        localStorage[PREFIX + id] = "1"
    }

    override fun clear() {
        val keys = (0 until localStorage.length).mapNotNull { localStorage.key(it) }
        keys.filter { it.startsWith(PREFIX) }.forEach { localStorage.removeItem(it) }
    }
}
