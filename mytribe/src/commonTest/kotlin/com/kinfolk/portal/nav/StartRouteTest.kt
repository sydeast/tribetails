package com.kinfolk.portal.nav

import com.kinfolk.portal.launch.LaunchDestination
import com.kinfolk.portal.util.SecureResetParams
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure resolver tests for startRouteFor. Mirrors LaunchRouterTest in style:
 * no Compose runtime, every branch exercised, precedence pinned.
 */
class StartRouteTest {

    // #905: an action link carries a mode and a continue target, and no email.
    private val reset = SecureResetParams(
        oobCode = "oob1",
        mode = "verifyEmail",
        continueUrl = "https://auntie.tribetails.com/signin",
    )

    @Test
    fun stillLoading_returnsNull() {
        val r = startRouteFor(
            secureReset = null, shareToken = null, claimId = null,
            dest = null, resolvedKinfolkId = null,
        )
        assertNull(r, "no funnel result yet should keep start route null (spinner)")
    }

    @Test
    fun secureReset_winsOverEverything() {
        val r = startRouteFor(
            secureReset = reset, shareToken = "tok", claimId = "inv",
            dest = LaunchDestination.SignIn, resolvedKinfolkId = "3",
        )
        assertTrue(r is SecureResetRoute)
        assertEquals("oob1", (r as SecureResetRoute).oobCode)
        assertEquals("verifyEmail", r.mode)
        assertEquals("https://auntie.tribetails.com/signin", r.continueUrl)
    }

    @Test
    fun share_winsOverClaimAndShell() {
        val r = startRouteFor(
            secureReset = null, shareToken = "tok", claimId = "inv",
            dest = null, resolvedKinfolkId = "3",
        )
        assertTrue(r is ShareRoute)
        assertEquals("tok", (r as ShareRoute).shareId)
    }

    @Test
    fun claim_winsOverShell() {
        val r = startRouteFor(
            secureReset = null, shareToken = null, claimId = "inv",
            dest = null, resolvedKinfolkId = "3",
        )
        assertTrue(r is ClaimRoute)
        assertEquals("inv", (r as ClaimRoute).inviteId)
    }

    @Test
    fun resolvedKinfolk_opensShellGraph() {
        val r = startRouteFor(
            secureReset = null, shareToken = null, claimId = null,
            dest = LaunchDestination.Home("3"), resolvedKinfolkId = "3",
        )
        assertTrue(r is ShellGraph)
        assertEquals("3", (r as ShellGraph).kinfolkId)
        assertEquals(false, r.cameFromPicker)
    }

    @Test
    fun resolvedKinfolk_carriesCameFromPicker() {
        val r = startRouteFor(
            secureReset = null, shareToken = null, claimId = null,
            dest = null, resolvedKinfolkId = "9", cameFromPicker = true,
        )
        assertTrue(r is ShellGraph)
        assertEquals(true, (r as ShellGraph).cameFromPicker)
    }

    @Test
    fun signIn_mapsToSignInRoute() {
        val r = startRouteFor(null, null, null, LaunchDestination.SignIn, null)
        assertEquals(SignInRoute, r)
    }

    @Test
    fun noTribes_mapsToNoTribesRoute() {
        val r = startRouteFor(null, null, null, LaunchDestination.NoTribes, null)
        assertEquals(NoTribesRoute, r)
    }

    @Test
    fun pick_mapsToTribePickerRoute_carryingOperatorFlag() {
        val r = startRouteFor(
            null, null, null,
            LaunchDestination.Pick(listOf("3", "5"), isOperator = true), null,
        )
        assertTrue(r is TribePickerRoute)
        assertEquals(true, (r as TribePickerRoute).isOperator)
    }

    @Test
    fun error_mapsToLaunchErrorRoute() {
        val r = startRouteFor(null, null, null, LaunchDestination.Error("boom"), null)
        assertTrue(r is LaunchErrorRoute)
        assertEquals("boom", (r as LaunchErrorRoute).message)
    }

    // #1293: a launch link the app could not place.
    @Test
    fun unknownLink_winsOverTheShell_butNotOverARecognisedLink() {
        val shell = startRouteFor(
            secureReset = null, shareToken = null, claimId = null,
            dest = null, resolvedKinfolkId = "3", unknownLink = true,
        )
        assertEquals(NotFoundRoute, shell)
        val signedOut = startRouteFor(
            secureReset = null, shareToken = null, claimId = null,
            dest = LaunchDestination.SignIn, resolvedKinfolkId = null, unknownLink = true,
        )
        assertEquals(NotFoundRoute, signedOut)
        // A claim or share link that did parse still goes where it names.
        val claim = startRouteFor(
            secureReset = null, shareToken = null, claimId = "inv",
            dest = null, resolvedKinfolkId = "3", unknownLink = true,
        )
        assertTrue(claim is ClaimRoute)
    }
    @Test
    fun clearingTheUnknownLink_returnsTheHouseholdToWhereTheyBelong() {
        val after = startRouteFor(
            secureReset = null, shareToken = null, claimId = null,
            dest = null, resolvedKinfolkId = "3", unknownLink = false,
        )
        assertTrue(after is ShellGraph)
    }
}
