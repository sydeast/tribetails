package com.kinfolk.portal.util

import java.util.prefs.Preferences

internal actual fun deviceBannerDismissals(): BannerDismissals =
    PrefsBannerDismissals("com/kinfolk/portal/dismissedBanners")

/**
 * JVM (desktop): one key per dismissed banner id in a user preferences node of
 * its own, which survives a restart (#1555). The node holds nothing else, so
 * [clear] cannot touch the other portal settings.
 *
 * Every dismissal is also kept in memory, so a locked or unwritable node, or an
 * id longer than [Preferences.MAX_KEY_LENGTH], still holds for the session.
 */
internal class PrefsBannerDismissals(private val nodePath: String) : BannerDismissals {
    private val memory = InMemoryBannerDismissals()

    private fun node(): Preferences = Preferences.userRoot().node(nodePath)

    private fun storable(id: String) = id.length <= Preferences.MAX_KEY_LENGTH

    override fun isDismissed(id: String): Boolean =
        memory.isDismissed(id) ||
            (storable(id) && runCatching { node().get(id, null) != null }.getOrDefault(false))

    override fun dismiss(id: String) {
        memory.dismiss(id)
        if (storable(id)) {
            runCatching {
                node().put(id, "1")
                node().flush()
            }
        }
    }

    override fun clear() {
        memory.clear()
        runCatching {
            node().clear()
            node().flush()
        }
    }
}
