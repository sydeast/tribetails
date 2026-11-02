package com.kinfolk.portal.config

/**
 * JVM (desktop): no release of its own, so "" unless a launcher passes
 * `-Dkinfolk.portal.version=...`. "" leaves the row off the About screen.
 */
actual fun appVersionName(): String = System.getProperty("kinfolk.portal.version")?.trim().orEmpty()
