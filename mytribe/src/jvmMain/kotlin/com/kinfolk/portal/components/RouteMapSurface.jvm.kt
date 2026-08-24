package com.kinfolk.portal.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Desktop keeps the Canvas polyline, permanently.
 *
 * There is no Mapbox SDK for a Compose desktop target, and the jvm target is not
 * a delivery surface anyway (see mytribe/CLAUDE.md). This is not a stub waiting
 * on a token: it is the finished answer for this target, and it is the same
 * renderer the jvm tests already cover.
 */
@Composable
internal actual fun RouteMapSurface(
    route: List<RoutePoint>,
    modifier: Modifier,
) {
    RouteCanvas(route = route, modifier = modifier)
}
