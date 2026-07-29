package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.GpsPoint
import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Canvas-projected GPS polyline. Pure Compose - no Mapbox SDK, so no
 * publish token required in the bundle. v1: equirectangular projection
 * scaled to fit the longest dimension of the bounding box; good enough
 * for neighborhood-scale visits.
 *
 * Mirrors web/.../sessions/RouteMap.kt but consumes Android's
 * [GpsPoint] (t: Long epoch-millis) directly instead of the web
 * Breadcrumb (timestamp: ISO String).
 *
 * @param live   true while session is ARRIVED (latest point pulses);
 *               false for replay (full polyline + start/end pins)
 */
@Composable
fun RouteMap(
    points: List<GpsPoint>,
    live: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (points.isEmpty()) {
            Text(
                text  = if (live) "Waiting for first GPS ping…" else "No GPS breadcrumbs recorded for this Kin Care.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textFaint,
            )
            return@Column
        }

        var pulsePhase by remember { mutableStateOf(0f) }
        LaunchedEffect(live) {
            while (live) {
                delay(80)
                pulsePhase = (pulsePhase + 0.08f) % 1f
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(c.surfaceGlass),
        ) {
            Canvas(modifier = Modifier.fillMaxWidth().height(180.dp)) {
                if (points.isEmpty()) return@Canvas

                val padPx = 16f
                val w = size.width  - padPx * 2
                val h = size.height - padPx * 2
                if (w <= 0 || h <= 0) return@Canvas

                var minLat = points.first().lat
                var maxLat = minLat
                var minLng = points.first().lng
                var maxLng = minLng
                for (p in points) {
                    minLat = min(minLat, p.lat); maxLat = max(maxLat, p.lat)
                    minLng = min(minLng, p.lng); maxLng = max(maxLng, p.lng)
                }
                val dLat = (maxLat - minLat).coerceAtLeast(1e-6)
                val dLng = (maxLng - minLng).coerceAtLeast(1e-6)
                val midLat = (minLat + maxLat) / 2.0
                val lngScale = cos(midLat * PI / 180.0)
                val effDLng = dLng * lngScale
                val scale = min(w / effDLng, h / dLat).toFloat()
                val drawnW = (effDLng * scale).toFloat()
                val drawnH = (dLat * scale).toFloat()
                val xOffset = padPx + (w - drawnW) / 2f
                val yOffset = padPx + (h - drawnH) / 2f

                fun project(p: GpsPoint): Offset {
                    val x = ((p.lng - minLng) * lngScale * scale).toFloat() + xOffset
                    val y = drawnH - ((p.lat - minLat) * scale).toFloat() + yOffset
                    return Offset(x, y)
                }

                if (points.size >= 2) {
                    val path = Path()
                    val first = project(points.first())
                    path.moveTo(first.x, first.y)
                    for (i in 1 until points.size) {
                        val pt = project(points[i])
                        path.lineTo(pt.x, pt.y)
                    }
                    drawPath(
                        path  = path,
                        color = primaryColor,
                        style = Stroke(width = 4f),
                    )
                }

                val start = project(points.first())
                drawCircle(color = startColor, radius = 6f, center = start)
                drawCircle(color = Color.White, radius = 2f, center = start)

                val last = project(points.last())
                if (live) {
                    val pulseR = 6f + pulsePhase * 18f
                    drawCircle(
                        color  = primaryColor.copy(alpha = (1f - pulsePhase) * 0.45f),
                        radius = pulseR,
                        center = last,
                    )
                    drawCircle(color = primaryColor, radius = 6f, center = last)
                    drawCircle(color = Color.White, radius = 2f, center = last)
                } else if (points.size >= 2) {
                    drawCircle(color = endColor,    radius = 6f, center = last)
                    drawCircle(color = Color.White, radius = 2f, center = last)
                }
            }
        }

        val distanceMeters = totalDistanceMeters(points)
        val durationMs     = durationMillis(points)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Stat("Distance", formatDistance(distanceMeters), modifier = Modifier)
            Stat("Duration", formatDuration(durationMs), modifier = Modifier)
            Stat("Pings",    points.size.toString(), modifier = Modifier)
        }
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier) {
    val c = AuntieTheme.colors
    Column(modifier = modifier) {
        Text(label.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.textFaint)
        Text(value, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    }
}

private val primaryColor = Color(0xFF7C3AED)
private val startColor   = Color(0xFF10B981)
private val endColor     = Color(0xFFEF4444)

internal fun totalDistanceMeters(points: List<GpsPoint>): Double {
    if (points.size < 2) return 0.0
    var total = 0.0
    for (i in 1 until points.size) {
        total += haversineMeters(points[i - 1], points[i])
    }
    return total
}

private fun haversineMeters(a: GpsPoint, b: GpsPoint): Double {
    val r = 6_371_000.0
    val dLat = (b.lat - a.lat) * PI / 180.0
    val dLng = (b.lng - a.lng) * PI / 180.0
    val lat1 = a.lat * PI / 180.0
    val lat2 = b.lat * PI / 180.0
    val s1 = sin(dLat / 2)
    val s2 = sin(dLng / 2)
    val h = s1 * s1 + cos(lat1) * cos(lat2) * s2 * s2
    return 2 * r * atan2(sqrt(h), sqrt(1 - h))
}

internal fun formatDistance(meters: Double): String {
    if (meters < 1.0) return "0 m"
    if (meters < 1_000.0) return "${meters.toInt()} m"
    val km = meters / 1_000.0
    return ((km * 10).toInt() / 10.0).toString() + " km"
}

internal fun durationMillis(points: List<GpsPoint>): Long {
    if (points.size < 2) return 0L
    val first = points.first().t
    val last  = points.last().t
    if (first == 0L || last == 0L) return 0L
    return (last - first).coerceAtLeast(0L)
}

/**
 * Pure mapping from the Firestore breadcrumb shape ([LocationPoint]) to the
 * shape [RouteMap] renders ([GpsPoint]). `internal` so JVM unit tests under
 * `src/test/.../ui/components/` can exercise it without Robolectric.
 *
 * Altitude / accuracy / speed / bearing are intentionally dropped - they are
 * not consumed by the canvas projection. Add a richer mapping if a future
 * caller needs them.
 */
internal fun locationPointToGpsPoint(lp: LocationPoint): GpsPoint =
    GpsPoint(lat = lp.latitude, lng = lp.longitude, t = lp.timestamp)

/**
 * Subcollection-subscribed sibling of [RouteMap]. Given a `kin_care_sessions`
 * document id, streams the `breadcrumbs` subcollection via
 * [KinCareRepository.observeBreadcrumbs], converts each [LocationPoint] to a
 * [GpsPoint], and delegates rendering to [RouteMap].
 *
 * Use this for live in-progress sessions and for replay once a session has
 * finished writing breadcrumbs. The legacy parent-doc `routePoints` array on
 * `kin_care_sessions/{sid}` is being phased out (Step 4 of the GPS refactor) -
 * callers that have a `sessionId` should migrate to [LiveRouteMap] and stop
 * reading `routePoints` directly.
 *
 * Known limitation (Step 6 hardening will address): repository errors from
 * [KinCareRepository.observeBreadcrumbs] are mapped to an empty list, which
 * renders [RouteMap]'s "Waiting for first GPS ping…" empty state. That is the
 * only user-visible signal of a failure right now - a fail-loud banner over
 * the map is the planned follow-up.
 *
 * @param sessionId  `kin_care_sessions/{sessionId}` document id
 * @param live       true while the session is ARRIVED (latest point pulses);
 *                   false for replay (full polyline + start/end pins)
 * @param repository defaults to [AuntieOSApp.instance.kinCareRepository] - the
 *                   established singleton access pattern used by VMs across
 *                   the app; override in previews/tests.
 */
@Composable
fun LiveRouteMap(
    sessionId: String,
    live: Boolean,
    modifier: Modifier = Modifier,
    repository: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
) {
    val pointsResult by repository.observeBreadcrumbs(sessionId)
        .collectAsState(initial = Result.success(emptyList<LocationPoint>()))
    val mapped = remember(pointsResult) {
        pointsResult.getOrDefault(emptyList()).map(::locationPointToGpsPoint)
    }
    RouteMap(points = mapped, live = live, modifier = modifier)
}

internal fun formatDuration(ms: Long): String {
    if (ms <= 0L) return "-"
    val totalSec = ms / 1_000
    val h = totalSec / 3_600
    val m = (totalSec % 3_600) / 60
    val s = totalSec % 60
    return when {
        h > 0 -> "${h}h ${m}m"
        m > 0 -> "${m}m ${s}s"
        else  -> "${s}s"
    }
}
