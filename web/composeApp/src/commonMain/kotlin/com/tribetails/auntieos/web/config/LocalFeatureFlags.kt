package com.tribetails.auntieos.web.config

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Ambient feature flags for the composable tree. Defaults to the compile-time
 * [FeatureFlags] baseline so any screen renders correctly before the remote
 * fetch resolves; the app root re-provides this once
 * [com.tribetails.auntieos.web.data.FirestoreClient.getFeatureFlags] returns.
 *
 * Usage in a screen: `val flags = LocalFeatureFlags.current` then gate UI on
 * e.g. `if (flags.invoicesGenerateReceipt) { ... }`.
 */
val LocalFeatureFlags = staticCompositionLocalOf { FeatureFlags() }
