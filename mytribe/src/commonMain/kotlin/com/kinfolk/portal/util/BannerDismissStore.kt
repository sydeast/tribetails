package com.kinfolk.portal.util

/**
 * Where this device keeps the ids of banners it dismissed. Each platform's
 * real one survives an app restart (#1555); [InMemoryBannerDismissals] is the
 * process-lifetime one a test hands [BannerDismissStore].
 */
interface BannerDismissals {
    fun isDismissed(id: String): Boolean
    fun dismiss(id: String)

    /** Forgets every dismissal on this device. No screen calls it; tests reset with it. */
    fun clear()
}

/** Process-lifetime dismissals: the test double, and each device store's fallback. */
class InMemoryBannerDismissals : BannerDismissals {
    private val dismissed = mutableSetOf<String>()

    override fun isDismissed(id: String): Boolean = id in dismissed

    override fun dismiss(id: String) {
        dismissed += id
    }

    override fun clear() {
        dismissed.clear()
    }
}

/**
 * The device store for this platform: SharedPreferences on Android (in memory
 * until the Application sets its context), the JVM user preferences node on
 * desktop, and localStorage on web under `dismissedBanner:{id}`, the key the
 * web portal has always written.
 */
internal expect fun deviceBannerDismissals(): BannerDismissals

/**
 * Per-device persistence for dismissed portal banners (`dismissMode == perDevice`).
 * A dismiss holds across app restarts on every client. perUser dismissal is the
 * synced path and does not go through here.
 */
object BannerDismissStore {
    /** The backing store. Tests swap in [InMemoryBannerDismissals] and put the device one back. */
    var backing: BannerDismissals = deviceBannerDismissals()

    /** True if the banner [id] was previously dismissed on this device. */
    fun isDismissed(id: String): Boolean = id.isNotBlank() && backing.isDismissed(id)

    /** Records that the banner [id] is dismissed on this device. */
    fun dismiss(id: String) {
        if (id.isNotBlank()) backing.dismiss(id)
    }
}
