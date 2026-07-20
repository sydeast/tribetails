package com.kinfolk.portal.nav

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.navigation.ExperimentalBrowserHistoryApi
import androidx.navigation.NavHostController
import androidx.navigation.bindToBrowserNavigation

/**
 * JS browser-history binding. Maps the NavController back stack to the browser
 * history so back / forward buttons drive pop / push and the current route is
 * reflected in a shareable, bookmarkable URL fragment.
 *
 * The init-only readInitial* readers (DeepLink.js.kt) still set the cold-start
 * route via startRouteFor; this binding takes over for every navigation after
 * first paint.
 */
@OptIn(ExperimentalBrowserHistoryApi::class)
@Composable
actual fun bindPlatformHistory(navController: NavHostController) {
    LaunchedEffect(navController) {
        // The launch funnel unmounts and remounts the NavHost between auth
        // states (SignIn -> spinner -> ShellGraph). The previous controller's
        // binding leaves its last route in the URL fragment; binding a FRESH
        // controller would read that stale fragment and navigate back to it,
        // killing the new start destination (observed: sign-in bouncing back
        // to SignInRoute). Strip the fragment first — the deep-link readers
        // (DeepLink.js.kt) already captured it at app init, and the binding
        // rewrites the correct route on its first sync.
        val loc = kotlinx.browser.window.location
        if (loc.hash.isNotEmpty()) {
            kotlinx.browser.window.history.replaceState(null, "", loc.pathname + loc.search)
        }
        navController.bindToBrowserNavigation()
    }
}
