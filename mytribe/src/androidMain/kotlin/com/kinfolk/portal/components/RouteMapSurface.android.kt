package com.kinfolk.portal.components

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.kinfolk.portal.config.MapboxPortalConfig
import com.mapbox.common.Cancelable
import com.mapbox.geojson.Point
import com.mapbox.maps.CameraOptions
import com.mapbox.maps.EdgeInsets
import com.mapbox.maps.MapLoadingErrorType
import com.mapbox.maps.MapView
import com.mapbox.maps.MapboxDelicateApi
import com.mapbox.maps.plugin.annotation.annotations
import com.mapbox.maps.plugin.annotation.generated.CircleAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.CircleAnnotationOptions
import com.mapbox.maps.plugin.annotation.generated.PolylineAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.PolylineAnnotationOptions
import com.mapbox.maps.plugin.annotation.generated.createCircleAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.createPolylineAnnotationManager

private const val TAG = "RouteMapSurface"

/**
 * Which renderer fills the map rectangle. Two states, and the fallback is the
 * default rather than the exception.
 */
internal enum class RouteSurface {
    /** A real Mapbox basemap: streets, landmarks, the context issue #520 is about. */
    Basemap,

    /** The polyline on a plain background, which is what every kinfolk sees today. */
    Canvas,
}

/**
 * The whole decision, as a pure function, so the fallback is testable without an
 * Android runtime or a network.
 *
 * A `MapView` is built ONLY for [MapboxPortalConfig.TokenApplication.Delivered].
 * That makes "the token is applied before any map is constructed" structural
 * rather than a convention someone has to remember: with no token applied there
 * is no code path that reaches a `MapView` constructor at all, so the Maps SDK
 * can never be asked to load a style it cannot authenticate.
 *
 * [tilesFailed] covers the case where the credential was fine and the basemap
 * still did not arrive - a revoked token, a scope that does not cover styles, an
 * offline device. It degrades to the same floor.
 */
internal fun routeSurfaceFor(
    tokenApplication: MapboxPortalConfig.TokenApplication,
    tilesFailed: Boolean,
): RouteSurface = when {
    tilesFailed -> RouteSurface.Canvas
    tokenApplication is MapboxPortalConfig.TokenApplication.Delivered -> RouteSurface.Basemap
    else -> RouteSurface.Canvas
}

/**
 * Whether a map-loading error means no basemap arrived.
 *
 * `STYLE` and `SOURCE` failures mean nothing drew: a 401 from a revoked or
 * wrongly-scoped token surfaces as a style-load failure, which is the case this
 * fallback is really for. `TILE`, `SPRITE` and `GLYPHS` failures are partial - a
 * single tile missing at the edge of a pan, an icon that did not fetch - and
 * dropping a working map to a line drawing over one of those would be a
 * regression, not a rescue. Those are logged and nothing more.
 */
internal fun isFatalMapLoadingError(type: MapLoadingErrorType): Boolean =
    type == MapLoadingErrorType.STYLE || type == MapLoadingErrorType.SOURCE

/**
 * Android draws the real map, and falls back to [RouteCanvas] whenever it
 * cannot.
 *
 * Mirrors `RouteViewerScreen.kt` in the AuntieOS app: one `MapView` remembered
 * across recompositions, lifecycle wiring and the error subscription registered
 * exactly once in a `DisposableEffect`, annotation managers reused rather than
 * stacked. Unlike that screen this one also has to handle a LIVE route -
 * ScheduleScreen streams breadcrumbs into it - so the polyline is redrawn from a
 * `LaunchedEffect` keyed on the route instead of captured once at construction.
 */
@Composable
internal actual fun RouteMapSurface(
    route: List<RoutePoint>,
    modifier: Modifier,
) {
    // Deliberately not keyed on `route`: a live route is a new list on every
    // ping, and re-keying would clear the failure the moment the next breadcrumb
    // arrived, flapping between the basemap and the polyline. Once a basemap has
    // failed to load it stays failed for this composition.
    var tilesFailed by remember { mutableStateOf(false) }

    when (routeSurfaceFor(MapboxPortalConfig.startupTokenApplication, tilesFailed)) {
        RouteSurface.Canvas -> RouteCanvas(route = route, modifier = modifier)
        RouteSurface.Basemap -> MapboxRouteSurface(
            route = route,
            modifier = modifier,
            onBasemapUnavailable = { tilesFailed = true },
        )
    }
}

@Composable
private fun MapboxRouteSurface(
    route: List<RoutePoint>,
    modifier: Modifier,
    onBasemapUnavailable: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    // Reached only when routeSurfaceFor said Basemap, which requires a delivered
    // token, so this constructor never runs on an unauthenticated SDK.
    val mapView = remember { MapView(context) }
    var styleLoaded by remember(mapView) { mutableStateOf(false) }

    DisposableEffect(mapView, lifecycleOwner) {
        // Fail-loud on the log, silent to the kinfolk: they get the polyline,
        // which is strictly what they had before this change, and never a map
        // error. Same subscribeMapLoadingError policy as the AuntieOS screens.
        val errorCancelable: Cancelable =
            mapView.mapboxMap.subscribeMapLoadingError { error ->
                Log.e(
                    TAG,
                    "Mapbox load error (type=${error.type}, sourceId=${error.sourceId}): ${error.message}",
                )
                if (isFatalMapLoadingError(error.type)) onBasemapUnavailable()
            }

        mapView.mapboxMap.loadStyle(MapboxPortalConfig.DEFAULT_STYLE) { styleLoaded = true }

        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> mapView.onStart()
                Lifecycle.Event.ON_STOP -> mapView.onStop()
                Lifecycle.Event.ON_DESTROY -> mapView.onDestroy()
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)

        onDispose {
            errorCancelable.cancel()
            lifecycleOwner.lifecycle.removeObserver(observer)
            mapView.onDestroy()
        }
    }

    // Redraw on every route change, which for a live visit is every GPS ping.
    // Annotations can only be created once a style exists, hence the gate.
    LaunchedEffect(mapView, styleLoaded, route) {
        if (!styleLoaded) return@LaunchedEffect
        drawRoute(mapView, route)
        fitCameraToRoute(mapView, route)
    }

    AndroidView(
        modifier = modifier,
        factory = { mapView },
        update = { /* No-op: route drawing is driven by the LaunchedEffect above,
                      lifecycle wiring by the DisposableEffect. */ },
    )
}

// Mapbox holds each AnnotationManager strongly internally, so creating one per
// recomposition would stack managers and their annotations on a live route that
// recomposes on every ping. Cached weakly per MapView, evicted when the view is
// collected after onDestroy. Same pattern, and same reason, as
// RouteViewerScreen.kt in the AuntieOS app.
private val polylineManagerCache = java.util.WeakHashMap<MapView, PolylineAnnotationManager>()
private val circleManagerCache = java.util.WeakHashMap<MapView, CircleAnnotationManager>()

private fun drawRoute(mapView: MapView, route: List<RoutePoint>) {
    if (route.isEmpty()) return
    val points = route.map { Point.fromLngLat(it.lng, it.lat) }

    if (points.size >= 2) {
        val lines = polylineManagerCache.getOrPut(mapView) {
            mapView.annotations.createPolylineAnnotationManager()
        }
        // Replace, never stack: without this each ping leaves its predecessor
        // behind in the same manager.
        lines.deleteAll()
        lines.create(
            PolylineAnnotationOptions()
                .withPoints(points)
                .withLineColor(MapboxPortalConfig.ROUTE_LINE_COLOR)
                .withLineWidth(MapboxPortalConfig.ROUTE_LINE_WIDTH),
        )
    }

    // Start and end pins, matching the two circles the Canvas fallback draws.
    // Circles rather than bitmap markers so they stay crisp at every zoom.
    val circles = circleManagerCache.getOrPut(mapView) {
        mapView.annotations.createCircleAnnotationManager()
    }
    circles.deleteAll()
    circles.create(pin(points.first(), MapboxPortalConfig.ROUTE_START_COLOR))
    if (points.size >= 2) {
        circles.create(pin(points.last(), MapboxPortalConfig.ROUTE_END_COLOR))
    }
}

private fun pin(point: Point, color: String): CircleAnnotationOptions =
    CircleAnnotationOptions()
        .withPoint(point)
        .withCircleColor(color)
        .withCircleRadius(6.0)
        .withCircleStrokeColor("#FFFFFF")
        .withCircleStrokeWidth(2.0)

// Mapbox's own bounds fitting rather than a hand-rolled centroid, so a long
// walk is framed at the zoom that actually fits it. A single ping has a
// degenerate bounding box, which cameraForCoordinates answers with zoom 0 - the
// whole planet - hence the explicit branch.
@OptIn(MapboxDelicateApi::class)
private fun fitCameraToRoute(mapView: MapView, route: List<RoutePoint>) {
    if (route.isEmpty()) return
    val points = route.map { Point.fromLngLat(it.lng, it.lat) }

    if (points.size == 1) {
        mapView.mapboxMap.setCamera(
            CameraOptions.Builder()
                .center(points.first())
                .zoom(MapboxPortalConfig.SINGLE_POINT_ZOOM)
                .build(),
        )
        return
    }

    // Padding keeps the polyline and its end pins off the edges of a rectangle
    // that is only 180dp tall.
    mapView.mapboxMap.setCamera(
        mapView.mapboxMap.cameraForCoordinates(
            coordinates = points,
            camera = CameraOptions.Builder().build(),
            coordinatesPadding = EdgeInsets(32.0, 32.0, 32.0, 32.0),
            maxZoom = null,
            offset = null,
        ),
    )
}
