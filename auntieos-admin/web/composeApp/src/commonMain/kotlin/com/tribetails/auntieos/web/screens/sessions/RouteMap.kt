package com.tribetails.auntieos.web.screens.sessions

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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.Breadcrumb
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Canvas-projected breadcrumb polyline. Pure Compose - no Mapbox JS SDK, so no
 * public access token has to ship in the bundle. v1: equirectangular projection
 * scaled to fit the longest dimension of the bounding box; good enough for
 * neighborhood-scale visits where the curvature of the earth is negligible.
 *
 * @param live   true while session is ARRIVED (latest crumb pulses)
 *               false for replay (full polyline + start/end pins)
 */
@Composable
fun RouteMap(
    breadcrumbs: List<Breadcrumb>,
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
        if (breadcrumbs.isEmpty()) {
            Text(
                text  = if (live) "Waiting for first GPS ping…" else "No GPS breadcrumbs recorded for this Kin Care.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textFaint,
            )
            return@Column
        }

        // Pulse animation tick for live mode; advances every 800ms.
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
                if (breadcrumbs.size < 1) return@Canvas

                val padPx = 16f
                val w = size.width  - padPx * 2
                val h = size.height - padPx * 2
                if (w <= 0 || h <= 0) return@Canvas

                // Bounding box
                var minLat = breadcrumbs.first().lat
                var maxLat = minLat
                var minLng = breadcrumbs.first().lng
                var maxLng = minLng
                for (b in breadcrumbs) {
                    minLat = min(minLat, b.lat); maxLat = max(maxLat, b.lat)
                    minLng = min(minLng, b.lng); maxLng = max(maxLng, b.lng)
                }
                val dLat = (maxLat - minLat).coerceAtLeast(1e-6)
                val dLng = (maxLng - minLng).coerceAtLeast(1e-6)
                // Compensate for longitude shrinking at higher latitudes.
                val midLat = (minLat + maxLat) / 2.0
                val lngScale = cos(midLat * PI / 180.0)
                val effDLng = dLng * lngScale
                val scale = min(w / effDLng, h / dLat).toFloat()
                // Center within the canvas
                val drawnW = (effDLng * scale).toFloat()
                val drawnH = (dLat * scale).toFloat()
                val xOffset = padPx + (w - drawnW) / 2f
                val yOffset = padPx + (h - drawnH) / 2f

                fun project(b: Breadcrumb): Offset {
                    val x = ((b.lng - minLng) * lngScale * scale).toFloat() + xOffset
                    // Flip Y so north renders up
                    val y = drawnH - ((b.lat - minLat) * scale).toFloat() + yOffset
                    return Offset(x, y)
                }

                if (breadcrumbs.size >= 2) {
                    val path = Path()
                    val first = project(breadcrumbs.first())
                    path.moveTo(first.x, first.y)
                    for (i in 1 until breadcrumbs.size) {
                        val p = project(breadcrumbs[i])
                        path.lineTo(p.x, p.y)
                    }
                    drawPath(
                        path  = path,
                        color = primaryColor,
                        style = Stroke(width = 4f),
                    )
                }

                val start = project(breadcrumbs.first())
                drawCircle(color = startColor, radius = 6f, center = start)
                drawCircle(color = Color.White,  radius = 2f, center = start)

                val last = project(breadcrumbs.last())
                if (live) {
                    val pulseR = 6f + pulsePhase * 18f
                    drawCircle(
                        color  = primaryColor.copy(alpha = (1f - pulsePhase) * 0.45f),
                        radius = pulseR,
                        center = last,
                    )
                    drawCircle(color = primaryColor, radius = 6f, center = last)
                    drawCircle(color = Color.White, radius = 2f, center = last)
                } else if (breadcrumbs.size >= 2) {
                    drawCircle(color = endColor,    radius = 6f, center = last)
                    drawCircle(color = Color.White, radius = 2f, center = last)
                }
            }
        }

        // ---- Distance / duration / ping count summary ----
        val distanceMeters = totalDistanceMeters(breadcrumbs)
        val durationMs     = durationMillis(breadcrumbs)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Stat("Distance", formatDistance(distanceMeters), modifier = Modifier)
            Stat("Duration", formatDuration(durationMs), modifier = Modifier)
            Stat("Pings",    breadcrumbs.size.toString(), modifier = Modifier)
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

// ---------- Geo math ----------

/** Sum of haversine distances between consecutive crumbs, in meters. */
internal fun totalDistanceMeters(crumbs: List<Breadcrumb>): Double {
    if (crumbs.size < 2) return 0.0
    var total = 0.0
    for (i in 1 until crumbs.size) {
        total += haversineMeters(crumbs[i - 1], crumbs[i])
    }
    return total
}

private fun haversineMeters(a: Breadcrumb, b: Breadcrumb): Double {
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

internal fun durationMillis(crumbs: List<Breadcrumb>): Long {
    if (crumbs.size < 2) return 0L
    val first = parseBreadcrumbMillis(crumbs.first().timestamp) ?: return 0L
    val last  = parseBreadcrumbMillis(crumbs.last().timestamp)  ?: return 0L
    return (last - first).coerceAtLeast(0L)
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

/**
 * A breadcrumb's clock as epoch millis, or null when it carries none this
 * understands.
 *
 * TWO WRITERS, TWO SHAPES, the same pair #607 found on the reader side. Android's
 * `LocationPoint` writes `timestamp` as epoch millis; the wasm web client retired
 * in #513 wrote it as an ISO string. [Breadcrumb.timestamp] is typed `String`
 * here, so a number arrives as its digits — which is why a digits-only input is
 * read as epoch millis before the ISO shape is tried.
 *
 * NULL, NEVER ZERO, on failure. Callers decide what an unknown clock means:
 * [durationMillis] degrades to "-" and `buildGpsSummary` writes the wire's
 * documented `t = 0` sentinel. Returning 0 from here would hand both of them a
 * real instant (1970-01-01) and make a parse bug indistinguishable from a
 * breadcrumb that genuinely never carried a clock. That is issue #615.
 *
 * Kept semantically identical to `parseIsoMs` in MyTribe's `BreadcrumbDecode.kt`
 * and to the two TypeScript normalizers (#611, #614). Change one, change all.
 */
internal fun parseBreadcrumbMillis(raw: String): Long? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    // Android's shape. `toLongOrNull` rejects a leading '+', decimals and overflow,
    // all of which are malformed rather than a clock worth trusting.
    if (trimmed.all { it in '0'..'9' }) return trimmed.toLongOrNull()
    return parseIsoMillis(trimmed)
}

/**
 * Best-effort ISO-8601 → epoch-millis. Accepts the slim "YYYY-MM-DDTHH:MM:SSZ"
 * form that [com.tribetails.auntieos.web.util.nowIso] emits. Returns null on
 * malformed input so callers degrade to "-" rather than crash.
 */
private fun parseIsoMillis(iso: String): Long? = runCatching {
    if (iso.length < 19) return@runCatching null
    val y = iso.substring(0, 4).toInt()
    val mo = iso.substring(5, 7).toInt()
    val d  = iso.substring(8, 10).toInt()
    val h  = iso.substring(11, 13).toInt()
    val mi = iso.substring(14, 16).toInt()
    val s  = iso.substring(17, 19).toInt()
    daysFromCivil(y, mo, d) * 86_400_000L +
        h * 3_600_000L + mi * 60_000L + s * 1_000L
}.getOrNull()

/** Howard Hinnant's civil-from-days algorithm, inverted to days-from-civil. */
private fun daysFromCivil(y: Int, m: Int, d: Int): Long {
    val yy = if (m <= 2) y - 1 else y
    val era = if (yy >= 0) yy / 400 else (yy - 399) / 400
    val yoe = (yy - era * 400).toLong()
    val mp = if (m > 2) m - 3 else m + 9
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097L + doe - 719_468L
}
