package com.kinfolk.portal.util

/**
 * Android: no localStorage equivalent wired up here, so per-device dismissals
 * are held in a process-lifetime in-memory set (holds for the session, not
 * across app restarts). See [BannerDismissStore] for rationale.
 */
actual object BannerDismissStore {
    private val dismissed = mutableSetOf<String>()

    actual fun isDismissed(id: String): Boolean = id.isNotBlank() && id in dismissed

    actual fun dismiss(id: String) {
        if (id.isNotBlank()) dismissed += id
    }
}
