package com.tribetails.auntieos.ui.admin

import android.util.Log
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.firebase.firestore.FirebaseFirestore
import com.mapbox.common.Cancelable
import com.mapbox.geojson.Point
import com.mapbox.maps.MapView
import com.mapbox.maps.Style
import com.mapbox.maps.plugin.annotation.annotations
import com.mapbox.maps.plugin.annotation.generated.createCircleAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.createPolylineAnnotationManager
import com.mapbox.maps.plugin.annotation.generated.CircleAnnotationOptions
import com.mapbox.maps.plugin.annotation.generated.PolylineAnnotationOptions
import com.tribetails.auntieos.config.MapboxConfig
import com.tribetails.auntieos.data.model.GpsPoint
import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.ui.components.RouteMap
import com.tribetails.auntieos.ui.location.fitCameraToRoute
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.floor
import kotlinx.coroutines.tasks.await

/**
 * The Kin Care route, drawn over a Mapbox SATELLITE basemap with the visit's
 * times and distance on a strip above it (#760).
 *
 * Operator ruling 2026-09-11, with the previous system's visit report on screen:
 * "this is what the map looks like and is usually listed under the arrival
 * departure times". Green arrival pin, red departure pin, purple marker on the
 * household, blue breadcrumb trail, zoom on the map, attribution from the SDK.
 * The web admin's `components/RouteMap.tsx` draws exactly this, with the same
 * four colours and the same header wording, so one visit reads the same on the
 * phone and on the desk.
 *
 * THE CANVAS POLYLINE IS THE FALLBACK, NOT THE TARGET. `ui/components/
 * RouteMap.kt` still draws every visit on a build with no Mapbox token:
 * `MapboxConfig.applyAccessToken` records `NoTokenConfigured` at startup, and
 * a handover that threw inside the SDK is recorded too. [hasMapboxToken] reads
 * both, so a build with no token and a device whose native library did not load
 * each show the plainer map rather than a grey rectangle or a crash. That is
 * the same split the web admin makes with `canRenderMapboxMap()` plus its
 * catch around the SDK's constructor.
 *
 * The map setup is `ui/location/RouteViewerScreen.kt`'s, reused rather than
 * re-derived: the same lifecycle observer, the same annotation managers, the
 * same `fitCameraToRoute`. What differs is the style, the colours, and that the
 * camera also has to hold the household point.
 */

/** The household's stored coordinate, off `kinfolk/{id}.serviceLocation`. */
data class HouseholdPoint(val lat: Double, val lng: Double)

/** The three pieces of the strip. Empty strings are clauses with no fact behind them. */
data class RouteHeaderStrip(val lead: String, val detail: String, val age: String)

private const val ARRIVAL_GREEN = "#3CB371"
private const val DEPARTURE_RED = "#D5535A"
private const val HOUSE_PURPLE = "#74538A"
private const val TRAIL_BLUE = "#4C9AFF"

private const val METERS_PER_MILE = 1609.344
private const val MINUTE_MS = 60_000L
private const val HOUR_MS = 60 * MINUTE_MS
private const val DAY_MS = 24 * HOUR_MS

/**
 * A visit timestamp as an instant. The session's ISO fields are written and read
 * as WALL CLOCK text everywhere else on this screen (`shortIso` slices the
 * string), so a naive local stamp is tried first and a zoned one second.
 */
internal fun visitInstantMillis(iso: String?): Long? {
    val trimmed = iso?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    runCatching {
        return LocalDateTime.parse(trimmed, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
            .atZone(ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli()
    }
    runCatching { return Instant.parse(trimmed).toEpochMilli() }
    return null
}

/**
 * `H:MM` for a visit length: "1:04". Seconds are dropped, not rounded up, so a
 * visit is reported at the minute it reached and never at one it did not.
 * Empty for zero or less, so the caller can leave the clause out.
 */
internal fun formatClockDuration(seconds: Long): String {
    if (seconds <= 0L) return ""
    val totalMinutes = seconds / 60
    return "${totalMinutes / 60}:${(totalMinutes % 60).toString().padStart(2, '0')}"
}

/**
 * Distance in miles, one decimal: "0.1 miles". Miles rather than the metric
 * `formatDistance` on the Canvas map below, because this figure is the one the
 * operator compares against the previous system's report.
 */
internal fun formatMiles(meters: Double): String {
    if (meters.isNaN() || meters <= 0.0) return "0 miles"
    val miles = floor(meters / METERS_PER_MILE * 10) / 10
    // Locale.US, not the device's: the decimal separator is part of the figure
    // the operator is comparing against the previous system's report, and a
    // phone set to a comma locale would print "0,1 miles" next to a web admin
    // printing "0.1 miles" for the same visit.
    return String.format(Locale.US, "%.1f miles", miles)
}

/** LOCAL `h:mma`: "12:05pm", "9:01am". Empty for a blank or unparseable stamp. */
internal fun clockTime(iso: String?): String {
    val millis = visitInstantMillis(iso) ?: return ""
    val at = Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault())
    val h24 = at.hour
    val h = if (h24 % 12 == 0) 12 else h24 % 12
    return "$h:${at.minute.toString().padStart(2, '0')}${if (h24 < 12) "am" else "pm"}"
}

private fun plural(count: Long, unit: String): String = "$count $unit${if (count == 1L) "" else "s"}"

/**
 * How long ago, in the coarsest unit that still says something. Coarse on
 * purpose: the exact instant is on this screen twice already, and what this
 * line answers is whether the office is looking at this morning's visit or at
 * one from the spring. A FUTURE stamp returns empty rather than a negative age.
 */
internal fun relativeAge(iso: String?, nowMillis: Long): String {
    val millis = visitInstantMillis(iso) ?: return ""
    val ms = nowMillis - millis
    if (ms < 0) return ""
    if (ms < MINUTE_MS) return "just now"
    if (ms < HOUR_MS) return "${plural(ms / MINUTE_MS, "minute")} ago"
    if (ms < DAY_MS) return "${plural(ms / HOUR_MS, "hour")} ago"
    val days = ms / DAY_MS
    if (days < 30) return "${plural(days, "day")} ago"
    if (days < 365) return "${plural(days / 30, "month")} ago"
    return "${plural(days / 365, "year")} ago"
}

/**
 * The strip, from the fields the session carries.
 *
 * DEPARTED IS NOT COMPLETED. The reference report writes "Completed at" over
 * what this system stores as `departedAt`, and the web screen's own header
 * carries the ruling that the two are different events: departing is the Auntie
 * leaving, completing is the office ruling the visit billable, and
 * `transitionBookingStatus` can stamp the second without the first. Naming one
 * as the other would put an invented completion time directly under a Lifecycle
 * section that prints the real one.
 *
 * A VISIT STILL IN FLIGHT GETS NO LENGTH AT ALL, whatever number the caller
 * passes, for the same reason: "Completed in 0:07" over a walk the Auntie is in
 * the middle of states a completion that has not happened. The departure stamp
 * is the gate, and `gpsSummary.durationSeconds` is only baked at DEPARTED
 * anyway, so a finished visit loses nothing.
 */
internal fun routeHeaderStrip(
    arrivedAt: String?,
    departedAt: String?,
    distanceMeters: Double?,
    durationSeconds: Long?,
    nowMillis: Long,
): RouteHeaderStrip {
    val arrived = visitInstantMillis(arrivedAt)
    val departed = visitInstantMillis(departedAt)
    val span = if (arrived != null && departed != null) ((departed - arrived) / 1000).coerceAtLeast(0) else 0L
    val seconds = if (durationSeconds != null && durationSeconds > 0L) durationSeconds else span

    val clauses = mutableListOf<String>()
    clockTime(arrivedAt).takeIf { it.isNotEmpty() }?.let { clauses += "Arrived at $it" }
    clockTime(departedAt).takeIf { it.isNotEmpty() }?.let { clauses += "Departed at $it" }
    if (distanceMeters != null && !distanceMeters.isNaN()) clauses += formatMiles(distanceMeters)

    val clock = if (departed == null) "" else formatClockDuration(seconds)
    return RouteHeaderStrip(
        lead = if (clock.isEmpty()) "" else "Completed in $clock",
        detail = clauses.joinToString(" - "),
        // From the END of the visit where there is one, and from the arrival
        // where there is not, so a visit in flight ages from the clock-in.
        age = relativeAge(departedAt, nowMillis).ifEmpty { relativeAge(arrivedAt, nowMillis) },
    )
}

/**
 * `serviceLocation` off a raw household document, or null when it is absent or
 * unusable.
 *
 * READ RAW, AND DELIBERATELY NOT ON THE `Kinfolk` MODEL. The coordinate is
 * written server-side by `onKinfolkAddressWrite` and never edited by hand, and
 * a field on the data class would be rebuilt from form state the next time
 * somebody saved the household from `KinfolkEditScreen`, which has no control
 * for it. A decoded-but-uneditable field is how that screen has wiped data
 * before. This reads the one value this map needs and leaves the model alone.
 *
 * `0, 0` is refused: it is a real coordinate in the Gulf of Guinea and it is
 * also what a half-written document holds, and a house marker three thousand
 * miles off the route reads as a tracking failure rather than a missing field.
 */
internal fun readHouseholdServiceLocation(data: Map<String, Any?>?): HouseholdPoint? {
    val raw = data?.get("serviceLocation") as? Map<*, *> ?: return null
    val lat = (raw["lat"] as? Number)?.toDouble() ?: return null
    val lng = (raw["lng"] as? Number)?.toDouble() ?: return null
    if (lat.isNaN() || lng.isNaN()) return null
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    if (lat == 0.0 && lng == 0.0) return null
    return HouseholdPoint(lat, lng)
}

/**
 * One household's stored coordinate, read straight off its document.
 *
 * NEVER THROWS, and that is what keeps it out of the way. The marker is the
 * least important thing on this screen: a denied read, an uninitialised
 * Firebase (every JVM unit test) or a household with no coordinate all mean the
 * same thing here, which is that the map draws a route and no house.
 */
internal suspend fun fetchHouseholdServiceLocation(kinfolkId: String): HouseholdPoint? {
    if (kinfolkId.isBlank()) return null
    return runCatching {
        val snap = FirebaseFirestore.getInstance().collection("kinfolk").document(kinfolkId).get().await()
        readHouseholdServiceLocation(snap.data)
    }.getOrNull()
}

/**
 * True when the Maps SDK actually TOOK a token at startup.
 *
 * DELIVERED WITH A deliveryError IS A NO, and that is exactly why `MapboxConfig`
 * records the failure instead of a boolean: the handover threw inside the SDK,
 * so there is no usable credential on the device however willing startup was.
 * `applyAccessToken`'s own header names the case, an `UnsatisfiedLinkError` from
 * the native call, and building a `MapView` after one would turn a missing
 * native library into a crash on a screen that has a perfectly good Canvas
 * polyline to fall back to.
 *
 * The web admin's third fallback condition is the same shape: `canRenderMapboxMap()`
 * says yes, mapbox-gl then fails to construct, and RouteMap draws the SVG.
 */
internal fun hasMapboxToken(): Boolean {
    val applied = MapboxConfig.startupTokenApplication
    return applied is MapboxConfig.TokenApplication.Delivered && applied.deliveryError == null
}

/**
 * The panel: the strip, then the satellite map, or the Canvas polyline when
 * this build has no token. The strip renders either way, because the times and
 * the distance are facts about the visit rather than decoration on a basemap.
 */
@Composable
fun KinCareRouteMap(
    points: List<GpsPoint>,
    header: RouteHeaderStrip,
    house: HouseholdPoint?,
    live: Boolean,
    modifier: Modifier = Modifier,
    mapboxAvailable: Boolean = hasMapboxToken(),
) {
    val c = AuntieTheme.colors
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        RouteHeaderStripRow(header)
        if (mapboxAvailable && points.isNotEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(240.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp)),
            ) {
                KinCareRouteMapView(points = points, house = house, modifier = Modifier.fillMaxWidth())
            }
        } else {
            RouteMap(points = points, live = live)
        }
    }
}

/**
 * The dark fact strip. Brand navy at 82% in BOTH themes, because on the map it
 * lies over aerial imagery rather than over an app surface, and a role colour
 * that flipped with the theme would put cream text on cream.
 */
@Composable
private fun RouteHeaderStripRow(header: RouteHeaderStrip) {
    if (header.lead.isEmpty() && header.detail.isEmpty() && header.age.isEmpty()) return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xD111131F))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            if (header.lead.isNotEmpty()) {
                Text(
                    text = header.lead,
                    style = AuntieTheme.typography.bodySmall,
                    fontWeight = FontWeight.Bold,
                    color = Color(0xFFFBFBF9),
                )
            }
            if (header.detail.isNotEmpty()) {
                Text(
                    text = header.detail,
                    style = AuntieTheme.typography.bodySmall,
                    color = Color(0xFFFBFBF9),
                )
            }
        }
        if (header.age.isNotEmpty()) {
            Text(
                text = header.age,
                style = AuntieTheme.typography.labelSmall,
                color = Color(0xFFCFCEC6),
            )
        }
    }
}

/**
 * The MapView itself. Built once and wired to the lifecycle in a
 * `DisposableEffect`, which is `RouteViewerScreen.RouteMapView`'s pattern and
 * exists there for the same reason: observers must be registered and removed
 * exactly once, not on every recomposition.
 */
@Composable
private fun KinCareRouteMapView(
    points: List<GpsPoint>,
    house: HouseholdPoint?,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    val mapView = remember(points, house) {
        MapView(context).apply {
            mapboxMap.loadStyle(MapboxConfig.SATELLITE_STYLE) { style ->
                drawKinCareRoute(this, points, house, style)
            }
        }
    }

    DisposableEffect(mapView, lifecycleOwner) {
        // Fail-loud policy, same as the route viewer: a refused style or tile
        // is logged rather than swallowed, and the map stays on screen.
        val errorCancelable: Cancelable = mapView.mapboxMap.subscribeMapLoadingError { error ->
            Log.e(
                "KinCareRouteMap",
                "Mapbox load error (type=${error.type}, sourceId=${error.sourceId}): ${error.message}",
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

    AndroidView(modifier = modifier, factory = { mapView }, update = { })
}

/**
 * The four marks. Circle annotations rather than bitmap pins, for the reason
 * `RouteViewerScreen.addCheckpointMarkers` gives: circles render through the
 * style engine and stay crisp at every zoom.
 *
 * ARRIVAL AND DEPARTURE COME OFF THE ROUTE, not off the timestamps. Those fields
 * record when somebody pressed a button; the first and last breadcrumb record
 * where the phone actually was. A one-ping route gets an arrival and no
 * departure, because stacking a red disc on a green one would report a visit
 * that began and ended in the same instant.
 */
private fun drawKinCareRoute(
    mapView: MapView,
    points: List<GpsPoint>,
    house: HouseholdPoint?,
    @Suppress("UNUSED_PARAMETER") style: Style,
) {
    if (points.isEmpty()) return
    val coordinates = points.map { Point.fromLngLat(it.lng, it.lat) }

    if (coordinates.size >= 2) {
        val lines = mapView.annotations.createPolylineAnnotationManager()
        lines.create(
            PolylineAnnotationOptions()
                .withPoints(coordinates)
                .withLineColor(TRAIL_BLUE)
                .withLineWidth(MapboxConfig.ROUTE_LINE_WIDTH),
        )
    }

    val circles = mapView.annotations.createCircleAnnotationManager()
    fun mark(point: Point, colorHex: String, radius: Double) {
        circles.create(
            CircleAnnotationOptions()
                .withPoint(point)
                .withCircleColor(colorHex)
                .withCircleRadius(radius)
                .withCircleStrokeColor("#FFFFFF")
                .withCircleStrokeWidth(2.0),
        )
    }
    // The house first, so the two end pins draw over it: a household whose
    // coordinate lands on its own driveway must not cover the arrival.
    house?.let { mark(Point.fromLngLat(it.lng, it.lat), HOUSE_PURPLE, 8.0) }
    mark(coordinates.first(), ARRIVAL_GREEN, 6.0)
    if (coordinates.size >= 2) mark(coordinates.last(), DEPARTURE_RED, 6.0)

    // The camera holds the house too. How far the walk ran from the home it
    // belongs to is what this panel is read for, and a fit to the trail alone
    // would crop the house out exactly when it was furthest away.
    fitCameraToRoute(mapView, cameraPoints(points, house))
}

/** The route as `LocationPoint`s, with the household appended when there is one. */
internal fun cameraPoints(points: List<GpsPoint>, house: HouseholdPoint?): List<LocationPoint> {
    val fromRoute = points.map { LocationPoint(latitude = it.lat, longitude = it.lng) }
    return if (house == null) fromRoute else fromRoute + LocationPoint(latitude = house.lat, longitude = house.lng)
}
