package com.tribetails.auntieos.ui.location

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.viewmodel.compose.viewModel
import android.util.Log
import com.mapbox.common.Cancelable
import com.mapbox.geojson.Point
import com.mapbox.maps.CoordinateBounds
import com.mapbox.maps.EdgeInsets
import com.mapbox.maps.MapView
import com.mapbox.maps.Style
import com.mapbox.maps.plugin.annotation.annotations
import com.mapbox.maps.plugin.annotation.generated.CircleAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.CircleAnnotationOptions
import com.mapbox.maps.plugin.annotation.generated.PolylineAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.PolylineAnnotationOptions
import com.mapbox.maps.plugin.annotation.generated.createCircleAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.createPolylineAnnotationManager
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.config.MapboxConfig
import com.tribetails.auntieos.data.admin.AuditLog
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.ui.components.LoadingScreen
import java.text.SimpleDateFormat
import java.util.*

@Composable
fun RouteViewerScreen(
    routeId: String,
    kinfolkName: String,
    viewModel: LocationTrackingViewModel = viewModel(),
    onBack: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    LaunchedEffect(routeId) {
        viewModel.loadRoute(routeId)
    }

    // Phase 3 GPS refactor: historic polyline now sourced from the
    // kin_care_sessions/{sessionId}/breadcrumbs subcollection (per
    // [[bug-sprint-architecture-decisions]]). VisitRoute.routePoints array is
    // being dropped in Step 4c.
    val repository = com.tribetails.auntieos.AuntieOSApp.instance.repository
    var historicPoints by remember(routeId) { mutableStateOf<List<com.tribetails.auntieos.data.model.LocationPoint>>(emptyList()) }
    LaunchedEffect(state.currentRoute?.kinCareSessionId) {
        val sid = state.currentRoute?.kinCareSessionId.orEmpty()
        if (sid.isNotBlank()) {
            repository.getBreadcrumbs(sid).onSuccess { historicPoints = it }
        }
    }

    AuntieScreenScaffold(
        title = "$kinfolkName - Visit Route",
        onBack = onBack,
        actions = {
            AuntieIconBtn(onClick = {
                val route = state.currentRoute
                if (route != null) {
                    val shareBody = buildRouteShareSummary(
                        kinfolkName = kinfolkName,
                        route       = route,
                        checkpoints = state.checkpoints,
                    )
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_SUBJECT, "Visit Route: $kinfolkName")
                        putExtra(Intent.EXTRA_TEXT, shareBody)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    runCatching {
                        // Wrapped in a chooser so the user picks the receiving app
                        // every time; matches the share-sheet pattern Android users
                        // expect for one-off plain-text payloads.
                        context.startActivity(Intent.createChooser(send, "Share Visit Route"))
                        AuditLog.fire(
                            scope            = scope,
                            repository       = AuntieOSApp.instance.repository,
                            actionType       = "ROUTE_SHARE_INITIATED",
                            description      = "Shared visit route summary for $kinfolkName",
                            targetId         = route.id,
                            targetCollection = "visit_routes",
                        )
                    }.onFailure { t ->
                        // Fail-loud: if no share target is available, surface to log
                        // so dev catches missing intent handlers in dev/test devices.
                        Log.e("RouteViewerScreen", "Share route failed: ${t.message}", t)
                    }
                }
            }) {
                Icon(Lucide.Share2, contentDescription = "Share Route")
            }
        },
        backgroundFullBleed = true,
    ) {
        if (state.isLoading) {
            LoadingScreen(
                message = "Loading route data...",
                modifier = Modifier.fillMaxSize()
            )
        } else if (state.error != null || state.currentRoute == null) {
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = state.error ?: "Route not found",
                    color = AuntieTheme.colors.error
                )
            }
        } else {
            val route = state.currentRoute!!
            Column(
                modifier = Modifier.fillMaxSize()
            ) {
                // Route Statistics
                RouteStatsCard(route)

                // Map View
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .padding(16.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .border(1.dp, AuntieTheme.colors.border, RoundedCornerShape(12.dp))
                ) {
                    RouteMapView(
                        route = route,
                        points = historicPoints,
                        checkpoints = state.checkpoints,
                        modifier = Modifier.fillMaxSize()
                    )
                }

                // Checkpoints Timeline
                if (state.checkpoints.isNotEmpty()) {
                    CheckpointsTimeline(state.checkpoints)
                }
            }
        }
    }
}

@Composable
private fun RouteStatsCard(route: VisitRoute) {
    AuntieCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                "VISIT SUMMARY",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                StatItem(
                    icon = Lucide.Footprints,
                    label = "Distance",
                    value = formatDistance(route.totalDistance)
                )
                StatItem(
                    icon = Lucide.Clock3,
                    label = "Duration",
                    value = formatDuration(route.totalDuration)
                )
                StatItem(
                    icon = Lucide.Gauge,
                    label = "Avg Speed",
                    value = formatSpeed(route.averageSpeed)
                )
            }

            if (route.visitVerified) {
                Spacer(Modifier.height(8.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Lucide.BadgeCheck,
                        contentDescription = "Verified",
                        tint = AuntieTheme.colors.success,
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Visit location verified",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.success
                    )
                }
            }

            if (route.arrivalTime.isNotBlank() && route.departureTime.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    "Arrival: ${formatTime(route.arrivalTime)} • Departure: ${formatTime(route.departureTime)}",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            }
        }
    }
}

@Composable
private fun StatItem(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    value: String
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = AuntieTheme.colors.kinfolkOrange,
            modifier = Modifier.size(24.dp)
        )
        Spacer(Modifier.height(4.dp))
        Text(
            value,
            style = AuntieTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold
        )
        Text(
            label,
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textDim
        )
    }
}

@Composable
private fun RouteMapView(
    route: VisitRoute,
    points: List<LocationPoint>,
    checkpoints: List<LocationCheckpoint>,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    // Stable MapView across recompositions: created once, lifecycle wiring happens in
    // DisposableEffect so observers are registered/removed exactly once (not on every
    // recomposition).
    val mapView = remember {
        MapView(context).apply {
            // v11 migration: use the mapboxMap property and loadStyle lambda.
            mapboxMap.loadStyle(MapboxConfig.DEFAULT_STYLE) { style ->
                if (points.isNotEmpty()) {
                    drawRoute(this, points, style)
                }
                if (checkpoints.isNotEmpty()) {
                    addCheckpointMarkers(this, checkpoints, style)
                }
                fitCameraToRoute(this, points)
            }
        }
    }

    // Register lifecycle observer + map-loading-error subscription ONCE.
    // DisposableEffect re-keys only if mapView or lifecycleOwner identity changes,
    // guaranteeing cleanup on dispose.
    DisposableEffect(mapView, lifecycleOwner) {
        // v11 migration: subscribeMapLoadingError replaces the removed
        // OnMapLoadErrorListener. Fail-loud policy: log errors.
        val errorCancelable: Cancelable =
            mapView.mapboxMap.subscribeMapLoadingError { error ->
                Log.e(
                    "RouteViewerScreen",
                    "Mapbox load error (type=${error.type}, " +
                        "sourceId=${error.sourceId}): ${error.message}"
                )
            }
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

    AndroidView(
        modifier = modifier,
        factory = { mapView },
        update = { /* No-op: route data captured at MapView creation; viewer screen is
                       static once loaded. Lifecycle wiring lives in DisposableEffect. */ }
    )
}

@Composable
private fun CheckpointsTimeline(checkpoints: List<LocationCheckpoint>) {
    AuntieCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp),
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                "VISIT TIMELINE",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            Spacer(Modifier.height(12.dp))

            LazyColumn(
                modifier = Modifier.heightIn(max = 200.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(checkpoints.sortedBy { it.timestamp }) { checkpoint ->
                    CheckpointItem(checkpoint)
                }
            }
        }
    }
}

@Composable
private fun CheckpointItem(checkpoint: LocationCheckpoint) {
    Row(
        verticalAlignment = Alignment.CenterVertically
    ) {
        val (icon, color) = when (checkpoint.checkpointType) {
            CheckpointType.START -> Lucide.Play to AuntieTheme.colors.kinfolkOrange
            CheckpointType.ARRIVAL -> Lucide.House to AuntieTheme.colors.success
            CheckpointType.WAYPOINT -> Lucide.MapPin to AuntieTheme.colors.textDim
            CheckpointType.PHOTO_STOP -> Lucide.Camera to AuntieTheme.colors.kinfolkOrange
            CheckpointType.DEPARTURE -> Lucide.LogOut to AuntieTheme.colors.textDim
            CheckpointType.END -> Lucide.Square to AuntieTheme.colors.kinfolkOrange
        }

        Icon(
            icon,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(20.dp)
        )

        Spacer(Modifier.width(12.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                checkpoint.description,
                style = AuntieTheme.typography.bodyMedium
            )
            Text(
                formatTime(checkpoint.timestamp),
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim
            )
        }
    }
}

// WeakHashMap caches the AnnotationManager per MapView so LiveTrackingScreen's
// update callback - which fires on every GPS ping - doesn't stack a new
// PolylineAnnotationManager + new annotation every recomposition. Mapbox holds
// each manager strongly internally; entries auto-evict when the MapView is
// garbage-collected (mapView.onDestroy() in DisposableEffect).
private val polylineManagerCache = java.util.WeakHashMap<MapView, PolylineAnnotationManager>()
private val circleManagerCache = java.util.WeakHashMap<MapView, CircleAnnotationManager>()

// Helper functions for drawing on map
internal fun drawRoute(mapView: MapView, routePoints: List<LocationPoint>, style: Style) {
    if (routePoints.size < 2) return

    val points = routePoints.map {
        Point.fromLngLat(it.longitude, it.latitude)
    }

    val manager = polylineManagerCache.getOrPut(mapView) {
        mapView.annotations.createPolylineAnnotationManager()
    }
    // Clear prior polyline so we replace, not stack. Without this each ping
    // accumulates a new annotation in the same manager → Mapbox runtime leak.
    manager.deleteAll()

    val polylineAnnotationOptions = PolylineAnnotationOptions()
        .withPoints(points)
        .withLineColor(MapboxConfig.ROUTE_LINE_COLOR)
        .withLineWidth(MapboxConfig.ROUTE_LINE_WIDTH)

    manager.create(polylineAnnotationOptions)
}

// Color-coded circle annotations per checkpoint type. Hex strings match the
// rest of the app's checkpoint palette so an "ARRIVAL" marker on the route map
// reads as the same color as the timeline icon below the map. Using
// CircleAnnotationManager (not PointAnnotationManager) keeps us off raster
// bitmap assets - circles render via the Mapbox style engine and stay crisp
// at every zoom level. Mapbox v11 API.
private fun addCheckpointMarkers(mapView: MapView, checkpoints: List<LocationCheckpoint>, style: Style) {
    val manager = circleManagerCache.getOrPut(mapView) {
        mapView.annotations.createCircleAnnotationManager()
    }
    manager.deleteAll()

    checkpoints.forEach { checkpoint ->
        val point = Point.fromLngLat(checkpoint.location.longitude, checkpoint.location.latitude)
        val color = checkpointColorHex(checkpoint.checkpointType)
        val options = CircleAnnotationOptions()
            .withPoint(point)
            .withCircleColor(color)
            .withCircleRadius(7.0)
            .withCircleStrokeColor("#FFFFFF")
            .withCircleStrokeWidth(2.0)
        manager.create(options)
    }
}

// Pure helper: hex color for a given CheckpointType. Extracted top-level so it
// can be unit-tested without the Android runtime per [[compose-pure-helper-tdd]].
internal fun checkpointColorHex(type: CheckpointType): String = when (type) {
    CheckpointType.START      -> "#C8A96E" // kinfolk gold - visit kicks off
    CheckpointType.ARRIVAL    -> "#3CB371" // success green - confirmed at home
    CheckpointType.WAYPOINT   -> "#9CA3AF" // dim grey - uneventful breadcrumb
    CheckpointType.PHOTO_STOP -> "#C8A96E" // kinfolk gold - owner-visible moment
    CheckpointType.DEPARTURE  -> "#9CA3AF" // dim grey - leaving the home
    CheckpointType.END        -> "#C8A96E" // kinfolk gold - visit complete
}

// v11 migration: use Mapbox's native bounds fitting API
// (mapboxMap.cameraForCoordinates) instead of hand-rolling a centroid. The
// engine picks the right zoom for the full route to fit inside the viewport
// with padding so the gold polyline isn't clipped at the edges. Single-point
// routes still hit the centroid fallback below (cameraForCoordinates would
// pick zoom 0 for a degenerate bounding box).
@OptIn(com.mapbox.maps.MapboxDelicateApi::class)
internal fun fitCameraToRoute(mapView: MapView, routePoints: List<LocationPoint>) {
    if (routePoints.isEmpty()) return

    val points = routePoints.map { Point.fromLngLat(it.longitude, it.latitude) }

    if (points.size == 1) {
        mapView.mapboxMap.setCamera(
            com.mapbox.maps.CameraOptions.Builder()
                .center(points.first())
                .zoom(MapboxConfig.DEFAULT_ZOOM)
                .build()
        )
        return
    }

    // 64dp padding equivalent - keeps the polyline off the screen edges so
    // checkpoint markers stay tappable on the route extremities.
    val padding = EdgeInsets(64.0, 64.0, 64.0, 64.0)
    val cameraOptions = mapView.mapboxMap.cameraForCoordinates(
        coordinates = points,
        camera      = com.mapbox.maps.CameraOptions.Builder().build(),
        coordinatesPadding = padding,
        maxZoom     = null,
        offset      = null,
    )
    mapView.mapboxMap.setCamera(cameraOptions)
}

/**
 * Pure-helper: builds the plain-text body that is shared via ACTION_SEND.
 * Extracted top-level + internal so we can unit-test the formatting under
 * pure JVM (no Android runtime) per [[compose-pure-helper-tdd]]. Mirrors the
 * RouteStatsCard layout: kinfolk name, distance, duration, avg speed,
 * arrival/departure, checkpoint count.
 */
internal fun buildRouteShareSummary(
    kinfolkName: String,
    route: VisitRoute,
    checkpoints: List<LocationCheckpoint>,
): String {
    val km     = route.totalDistance / 1000.0
    val minutes = route.totalDuration / 60_000
    val kmh    = route.averageSpeed * 3.6
    return buildString {
        appendLine("Visit Route: $kinfolkName")
        appendLine()
        appendLine("Distance:   ${"%.2f".format(km)} km")
        appendLine("Duration:   ${minutes} min")
        appendLine("Avg speed:  ${"%.1f".format(kmh)} km/h")
        if (route.visitVerified) appendLine("Verified at client home: yes")
        if (route.arrivalTime.isNotBlank())   appendLine("Arrived:    ${route.arrivalTime}")
        if (route.departureTime.isNotBlank()) appendLine("Departed:   ${route.departureTime}")
        if (checkpoints.isNotEmpty()) {
            appendLine()
            appendLine("Checkpoints (${checkpoints.size}):")
            checkpoints.sortedBy { it.timestamp }.forEach { cp ->
                appendLine("  • ${cp.checkpointType.name}: ${cp.description.ifBlank { "(no description)" }}")
            }
        }
    }.trimEnd()
}

// Utility formatting functions
private fun formatDistance(meters: Double): String {
    return if (meters >= 1000) {
        String.format("%.1f km", meters / 1000.0)
    } else {
        String.format("%.0f m", meters)
    }
}

private fun formatDuration(milliseconds: Long): String {
    val minutes = milliseconds / 60000
    val hours = minutes / 60
    val remainingMinutes = minutes % 60

    return if (hours > 0) {
        "${hours}h ${remainingMinutes}m"
    } else {
        "${minutes}m"
    }
}

private fun formatSpeed(mps: Double): String {
    val kmh = mps * 3.6
    return if (kmh < 1.0) {
        "Walking"
    } else {
        String.format("%.1f km/h", kmh)
    }
}

private fun formatTime(timestamp: String): String {
    return try {
        val instant = java.time.Instant.parse(timestamp)
        val formatter = SimpleDateFormat("HH:mm", Locale.getDefault())
        formatter.format(Date(instant.toEpochMilli()))
    } catch (e: Exception) {
        timestamp
    }
}
