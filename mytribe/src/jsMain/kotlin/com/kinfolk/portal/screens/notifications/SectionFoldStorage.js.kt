package com.kinfolk.portal.screens.notifications

import kotlinx.browser.localStorage
import org.w3c.dom.get
import org.w3c.dom.set

/** Web: localStorage, the same key and JSON array the React portal writes (NotificationSettings.tsx). */
actual object SectionFoldStorage {
    private const val KEY = "notificationSettings:collapsedSections"

    actual fun load(): String? = localStorage[KEY]

    actual fun save(raw: String) {
        localStorage[KEY] = raw
    }
}
