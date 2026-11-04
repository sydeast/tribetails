package com.kinfolk.portal.util

import android.content.Context
import android.content.SharedPreferences
import com.kinfolk.portal.KinfolkPortalApplication

internal actual fun deviceBannerDismissals(): BannerDismissals = SharedPrefsBannerDismissals {
    KinfolkPortalApplication.appContext?.getSharedPreferences("banner_dismissals", Context.MODE_PRIVATE)
}

/**
 * Android: SharedPreferences, one boolean per dismissed banner id, so a dismiss
 * survives an app restart (#1555). Every dismissal is also kept in memory, the
 * fallback when the Application has not set its context yet (a preview, a test
 * host), as SectionFoldStorage and BusinessPublicCardStore do.
 */
internal class SharedPrefsBannerDismissals(
    private val prefs: () -> SharedPreferences?,
) : BannerDismissals {
    private val memory = InMemoryBannerDismissals()

    override fun isDismissed(id: String): Boolean =
        memory.isDismissed(id) || prefs()?.getBoolean(id, false) == true

    override fun dismiss(id: String) {
        memory.dismiss(id)
        prefs()?.edit()?.putBoolean(id, true)?.apply()
    }

    override fun clear() {
        memory.clear()
        prefs()?.edit()?.clear()?.apply()
    }
}
