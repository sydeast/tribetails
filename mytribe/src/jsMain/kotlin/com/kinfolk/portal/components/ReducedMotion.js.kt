package com.kinfolk.portal.components

import com.kinfolk.portal.error.runCatchingCancellable
import kotlinx.browser.window

/**
 * The literal web query, for the Kotlin/JS target. Guarded because `matchMedia`
 * is absent in some non-browser JS hosts, where the honest answer is "no
 * preference expressed" rather than a thrown error.
 */
actual fun animationsEnabled(): Boolean =
    runCatchingCancellable { !window.matchMedia("(prefers-reduced-motion: reduce)").matches }
        .getOrDefault(true)
