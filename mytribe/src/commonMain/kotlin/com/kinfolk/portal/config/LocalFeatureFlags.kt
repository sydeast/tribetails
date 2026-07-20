package com.kinfolk.portal.config

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Ambient feature flags for the composable tree. All `mytribe.*` flags have been
 * removed and their features now ship always-on, so [FeatureFlags] is empty; this
 * ambient and the [com.kinfolk.portal.portal.PortalApi.getFeatureFlags] plumbing
 * are kept intact for compatibility.
 */
val LocalFeatureFlags = staticCompositionLocalOf { FeatureFlags() }
