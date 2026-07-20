package com.kinfolk.portal.nav

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController

/**
 * Binds the NavController to platform browser history where one exists.
 *
 * On js this wires browser back / forward and shareable, bookmarkable URLs to
 * the back stack (the current route becomes the URL fragment). On android and
 * jvm there is no browser history, so the actual is a no-op: nav runs purely
 * in memory and system back is handled by navigation-compose itself.
 *
 * Call this once, inside composition, after the NavController is created.
 */
@Composable
expect fun bindPlatformHistory(navController: NavHostController)
