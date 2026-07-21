package com.tribetails.auntieos.config

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Ambient feature flags for the composable tree (Android parity with web
 * `com.tribetails.auntieos.web.config.LocalFeatureFlags`). Defaults to the compile-time
 * [FeatureFlags] baseline so any screen renders before the remote fetch resolves; the app
 * root re-provides this once getFeatureFlags returns.
 *
 * Usage: `val flags = LocalFeatureFlags.current` then gate UI on `if (flags.invoicesCreate) { ... }`.
 */
val LocalFeatureFlags = staticCompositionLocalOf { FeatureFlags() }
