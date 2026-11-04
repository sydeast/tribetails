package com.kinfolk.portal.screens.notifications

import java.util.prefs.Preferences

/**
 * JVM (desktop): the user's Java preferences node, which survives a restart.
 * A locked or unwritable node is swallowed by [DeviceSectionFoldStore]; the
 * screen never depends on it.
 */
actual object SectionFoldStorage {
    private const val KEY = "notificationCollapsedSections"

    private fun node(): Preferences = Preferences.userRoot().node("com/kinfolk/portal")

    actual fun load(): String? = node().get(KEY, null)

    actual fun save(raw: String) {
        node().put(KEY, raw)
    }
}
