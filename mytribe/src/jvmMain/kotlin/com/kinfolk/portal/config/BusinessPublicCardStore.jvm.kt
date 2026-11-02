package com.kinfolk.portal.config

import java.util.prefs.Preferences

/**
 * JVM (desktop): the user's Java preferences node, which survives a restart.
 * A locked or unwritable preferences store is swallowed by the caller
 * ([BusinessPublicCardCache]); the sign-in form never depends on it.
 */
actual object BusinessPublicCardStore {
    private const val KEY = "businessPublicCard"

    private fun node(): Preferences = Preferences.userRoot().node("com/kinfolk/portal")

    actual fun load(): String? = node().get(KEY, null)

    actual fun save(json: String) {
        node().put(KEY, json)
    }
}
