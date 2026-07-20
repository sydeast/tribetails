package com.kinfolk.portal.firebase

import java.util.prefs.Preferences

/**
 * Persists Firebase refresh-token + cached user info between desktop sessions.
 * Uses java.util.prefs (per-user). Cleared on signOut.
 */
internal object JvmTokenStore {
    private val prefs: Preferences = Preferences.userRoot().node("com/kinfolk/portal/firebase")

    private const val KEY_REFRESH = "refresh_token"
    private const val KEY_UID = "uid"
    private const val KEY_EMAIL = "email"
    private const val KEY_DISPLAY_NAME = "display_name"

    var refreshToken: String?
        get() = prefs.get(KEY_REFRESH, null)
        set(value) {
            if (value == null) prefs.remove(KEY_REFRESH) else prefs.put(KEY_REFRESH, value)
        }

    var uid: String?
        get() = prefs.get(KEY_UID, null)
        set(value) {
            if (value == null) prefs.remove(KEY_UID) else prefs.put(KEY_UID, value)
        }

    var email: String?
        get() = prefs.get(KEY_EMAIL, null)
        set(value) {
            if (value == null) prefs.remove(KEY_EMAIL) else prefs.put(KEY_EMAIL, value)
        }

    var displayName: String?
        get() = prefs.get(KEY_DISPLAY_NAME, null)
        set(value) {
            if (value == null) prefs.remove(KEY_DISPLAY_NAME) else prefs.put(KEY_DISPLAY_NAME, value)
        }

    fun clear() {
        prefs.remove(KEY_REFRESH)
        prefs.remove(KEY_UID)
        prefs.remove(KEY_EMAIL)
        prefs.remove(KEY_DISPLAY_NAME)
    }
}
