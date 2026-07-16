package com.kinfolk.portal.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Single GPS ping along a visit route. Forwarded by AuntieOS into the kinTale
 * doc, then surfaced here so the kinfolk can see where Auntie walked their kin.
 * `t` is optional — if missing the duration stat falls back to "—".
 */
data class RoutePoint(
    val lat: Double,
    val lng: Double,
    val t: Long? = null,
)

/**
 * Replay-only route renderer for past visits. Mirrors the AuntieOS-side
 * `RouteMap` composable but simpler — no live pulse, no breadcrumb reads.
 * Pure Compose Canvas, no map SDK, no public access token shipped.
 */
@Composable
fun RouteMap(
    route: List<RoutePoint>,
    distanceMeters: Double? = null,
    durationSeconds: Long? = null,
    modifier: Modifier = Modifier,
) {
    if (route.isEmpty()) return
    val type = LocalKinfolkTypography.current

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(KinfolkBrand.GlassSurface)
            .border(0.5.dp, KinfolkBrand.GlassBorder, RoundedCornerShape(12.dp))
            .padding(KinfolkSpacing.s),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(KinfolkBrand.GlassSurfaceDim),
        ) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val padPx = 16f
                val w = size.width  - padPx * 2
                val h = size.height - padPx * 2
                if (w <= 0 || h <= 0) return@Canvas

                var minLat = route.first().lat; var maxLat = minLat
                var minLng = route.first().lng; var maxLng = minLng
                for (p in route) {
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
                val xOff = padPx + (w - drawnW) / 2f
                val yOff = padPx + (h - drawnH) / 2f

                fun project(p: RoutePoint): Offset {
                    val x = ((p.lng - minLng) * lngScale * scale).toFloat() + xOff
                    val y = drawnH - ((p.lat - minLat) * scale).toFloat() + yOff
                    return Offset(x, y)
                }

                if (route.size >= 2) {
                    val path = Path()
                    val first = project(route.first())
                    path.moveTo(first.x, first.y)
                    for (i in 1 until route.size) {
                        val q = project(route[i])
                        path.lineTo(q.x, q.y)
                    }
                    drawPath(path = path, color = KinfolkBrand.KinTeal, style = Stroke(width = 4f))
                }

                val start = project(route.first())
                drawCircle(color = KinfolkBrand.KinfolkOrange, radius = 6f, center = start)
                drawCircle(color = Color.White, radius = 2f, center = start)

                if (route.size >= 2) {
                    val last = project(route.last())
                    drawCircle(color = KinfolkBrand.PackPink, radius = 6f, center = last)
                    drawCircle(color = Color.White, radius = 2f, center = last)
                }
            }
        }

        val computedDistance = distanceMeters ?: totalDistanceMeters(route)
        val computedDuration = durationSeconds ?: durationFromPoints(route)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
        ) {
            Stat("Distance", formatDistance(computedDistance))
            Stat("Duration", formatDuration(computedDuration))
            Stat("Pings",    route.size.toString())
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    val type = LocalKinfolkTypography.current
    Column {
        Text(label.uppercase(), style = type.sansLabel, color = KinfolkBrand.NavyMuted)
        Text(value, style = type.sansBody)
    }
}

internal fun totalDistanceMeters(route: List<RoutePoint>): Double {
    if (route.size < 2) return 0.0
    var total = 0.0
    for (i in 1 until route.size) total += haversineMeters(route[i - 1], route[i])
    return total
}

private fun haversineMeters(a: RoutePoint, b: RoutePoint): Double {
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

private fun durationFromPoints(route: List<RoutePoint>): Long {
    val first = route.firstOrNull()?.t ?: return 0L
    val last  = route.lastOrNull()?.t  ?: return 0L
    return ((last - first) / 1000L).coerceAtLeast(0L)
}

internal fun formatDistance(meters: Double): String {
    if (meters < 1.0) return "0 m"
    if (meters < 1_000.0) return "${meters.toInt()} m"
    val km = meters / 1_000.0
    return ((km * 10).toInt() / 10.0).toString() + " km"
}

internal fun formatDuration(seconds: Long): String {
    if (seconds <= 0L) return "—"
    val h = seconds / 3_600
    val m = (seconds % 3_600) / 60
    val s = seconds % 60
    return when {
        h > 0 -> "${h}h ${m}m"
        m > 0 -> "${m}m ${s}s"
        else  -> "${s}s"
    }
}
