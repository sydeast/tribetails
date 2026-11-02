package com.kinfolk.portal.config

import android.content.Context
import com.kinfolk.portal.KinfolkPortalApplication

/**
 * Android: SharedPreferences, so the business name is on the sign-in screen the
 * moment a cold start draws it (#1321). Falls back to a process-lifetime value
 * when the Application has not set its context yet (a preview, a test host).
 */
actual object BusinessPublicCardStore {
    private const val FILE = "business_public_card"
    private const val KEY = "card"
    private var fallback: String? = null

    private fun prefs() = KinfolkPortalApplication.appContext?.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    actual fun load(): String? = prefs()?.getString(KEY, null) ?: fallback

    actual fun save(json: String) {
        fallback = json
        prefs()?.edit()?.putString(KEY, json)?.apply()
    }
}
