package com.kinfolk.portal.nav

import com.kinfolk.portal.launch.LaunchDestination
import kotlin.test.Test
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #539, Android half: a signed-out kinfolk must not reach an authenticated
 * screen through the back stack.
 *
 * The back stack itself is cleared by AppNavHost — the NavHost is only composed
 * while [shellStartRoute] returns non-null, and a start route that changes
 * re-navigates with `popUpTo(0) { inclusive = true }`. What decides both is this
 * function, so this is where the rule is pinned.
 *
 * The case that matters is the one in the middle of a sign-out. Pressing Sign
 * Out clears the loaded home synchronously, several hundred milliseconds before
 * the auth state flips — so at that instant the launch funnel still says Home
 * and still carries a kinfolk id. If the shell were allowed to stay mounted on
 * the strength of that, the previous kinfolk's household would remain on screen,
 * and on its back stack, for as long as the teardown took.
 */
class ShellStartRouteTest {

    @Test
    fun signOutInFlight_dropsTheShell_beforeAuthHasEvenFlipped() {
        val route = shellStartRoute(
            secureReset = null,
            shareToken = null,
            claimId = null,
            // Still SignedIn: repo.signOut() has not landed yet.
            dest = LaunchDestination.Home("kin-1"),
            resolvedKinfolkId = "kin-1",
            homeLoaded = false,
        )

        assertNull(route, "the shell must come down the moment sign-out clears the home payload")
    }

    @Test
    fun signedOut_opensSignIn_withNothingBehindIt() {
        val route = shellStartRoute(
            secureReset = null,
            shareToken = null,
            claimId = null,
            dest = LaunchDestination.SignIn,
            resolvedKinfolkId = null,
            homeLoaded = false,
        )

        // A different start route from the shell's, so AppNavHost re-navigates
        // with popUpTo(0) { inclusive = true } and the old stack is gone.
        assertTrue(route is SignInRoute, "expected SignInRoute, got $route")
        assertTrue(routeKey(route) != routeKey(ShellGraph("kin-1", cameFromPicker = false)))
    }

    @Test
    fun signedIn_withHomeLoaded_opensTheShell() {
        val route = shellStartRoute(
            secureReset = null,
            shareToken = null,
            claimId = null,
            dest = LaunchDestination.Home("kin-1"),
            resolvedKinfolkId = "kin-1",
            homeLoaded = true,
        )

        assertTrue(route is ShellGraph, "expected ShellGraph, got $route")
    }

    @Test
    fun noResolvedKinfolk_doesNotWaitOnAHomeItWillNeverGet() {
        // The signed-out and no-tribes funnels have no getMyHome to wait for;
        // gating them on homeLoaded would hang the app on a spinner forever.
        val route = shellStartRoute(
            secureReset = null,
            shareToken = null,
            claimId = null,
            dest = LaunchDestination.NoTribes,
            resolvedKinfolkId = null,
            homeLoaded = false,
        )

        assertTrue(route is NoTribesRoute, "expected NoTribesRoute, got $route")
    }
}
