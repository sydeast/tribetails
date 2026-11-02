package com.kinfolk.portal.config

import kotlinx.browser.localStorage
import org.w3c.dom.get
import org.w3c.dom.set

/** Web: localStorage, the same key the React portal uses (`lib/businessPublicCard.ts`). */
actual object BusinessPublicCardStore {
    private const val KEY = "businessPublicCard"

    actual fun load(): String? = localStorage[KEY]

    actual fun save(json: String) {
        localStorage[KEY] = json
    }
}
