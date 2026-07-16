package com.kinfolk.portal.nav

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController

/** Desktop has no browser history; nav runs in memory. No-op. */
@Composable
actual fun bindPlatformHistory(navController: NavHostController) {
    // No browser history on desktop. System back is handled by navigation-compose.
}
