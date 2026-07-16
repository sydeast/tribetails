package com.kinfolk.portal.util

/**
 * Per-device persistence for dismissed portal banners (`dismissMode == perDevice`).
 *
 * On web this is backed by `localStorage` (key `dismissedBanner:{id}`), so a
 * dismiss survives reloads on that browser. On Android/JVM there is no
 * localStorage equivalent wired up here, so the actual falls back to a process-
 * lifetime in-memory set — the dismiss holds for the session but not across
 * app restarts. (perUser dismiss, which DOES persist, is the synced path.)
 */
expect object BannerDismissStore {
    /** True if the banner [id] was previously dismissed on this device. */
    fun isDismissed(id: String): Boolean

    /** Records that the banner [id] is dismissed on this device. */
    fun dismiss(id: String)
}
