package com.kinfolk.portal.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * The Compose js target keeps the Canvas polyline, permanently.
 *
 * The kinfolk web portal that ships at kinfolk.tribetails.com is the React app in
 * `mytribe/web`, and its own `RouteMap.tsx` is where mapbox-gl lands. This
 * Compose js target is a different build with no map SDK available to it, so the
 * Canvas renderer is its finished answer rather than a placeholder.
 */
@Composable
internal actual fun RouteMapSurface(
    route: List<RoutePoint>,
    modifier: Modifier,
) {
    RouteCanvas(route = route, modifier = modifier)
}
