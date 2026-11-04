package com.kinfolk.portal.screens.notifications

import android.content.Context
import com.kinfolk.portal.KinfolkPortalApplication

/**
 * Android: SharedPreferences, so a folded section stays folded after the app
 * restarts (#1545). Falls back to a process-lifetime value when the Application
 * has not set its context yet (a preview, a test host), as
 * BusinessPublicCardStore does.
 */
actual object SectionFoldStorage {
    private const val FILE = "notification_settings"
    private const val KEY = "collapsedSections"
    private var fallback: String? = null

    private fun prefs() = KinfolkPortalApplication.appContext?.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    actual fun load(): String? = prefs()?.getString(KEY, null) ?: fallback

    actual fun save(raw: String) {
        fallback = raw
        prefs()?.edit()?.putString(KEY, raw)?.apply()
    }
}
