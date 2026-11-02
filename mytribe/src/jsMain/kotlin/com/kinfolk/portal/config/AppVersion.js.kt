package com.kinfolk.portal.config

/**
 * Kotlin/JS: the shipped web portal is the React app (`mytribe/web`), whose
 * `lib/appVersion.ts` carries the number. This target has none and answers "",
 * which leaves the row off the About screen.
 */
actual fun appVersionName(): String = ""
