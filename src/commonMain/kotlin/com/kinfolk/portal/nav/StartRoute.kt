package com.kinfolk.portal.nav

import com.kinfolk.portal.launch.LaunchDestination
import com.kinfolk.portal.util.SecureResetParams

/**
 * Pure resolver for the NavHost start destination (and for reactive
 * re-navigation when the launch funnel changes). Exported separately from the
 * Compose layer so tests can hit every branch without a Compose runtime.
 *
 * Precedence mirrors the old hand-rolled short-circuits in
 * KinfolkPortalAppGuarded: the three unauth deep-link terminals win before
 * auth, then a resolved kinfolk opens the signed-in shell, then the launch
 * funnel decides sign-in / no-tribes / picker / error.
 *
 * Returns null while still loading (auth or getMyAccess in flight) so the
 * caller shows a spinner and does not mount the NavHost yet.
 */
fun startRouteFor(
    secureReset: SecureResetParams?,
    shareToken: String?,
    claimId: String?,
    dest: LaunchDestination?,
    resolvedKinfolkId: String?,
    cameFromPicker: Boolean = false,
): Any? = when {
    secureReset != null -> SecureResetRoute(secureReset.oobCode, secureReset.email)
    shareToken != null -> ShareRoute(shareToken)
    claimId != null -> ClaimRoute(claimId)
    resolvedKinfolkId != null -> ShellGraph(resolvedKinfolkId, cameFromPicker = cameFromPicker)
    dest is LaunchDestination.SignIn -> SignInRoute
    dest is LaunchDestination.NoTribes -> NoTribesRoute
    dest is LaunchDestination.Pick -> TribePickerRoute(dest.isOperator)
    dest is LaunchDestination.Error -> LaunchErrorRoute(dest.message)
    else -> null
}

/**
 * Stable identity for a route instance, used to detect when the reactive launch
 * funnel produced a different start destination and the NavHost must
 * re-navigate. Route types are @Serializable data classes / objects, so their
 * toString uniquely captures both the destination and its args.
 */
fun routeKey(route: Any): String = route.toString()
