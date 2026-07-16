package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.GpsPoint
import com.tribetails.auntieos.web.data.GpsSummary
import com.tribetails.auntieos.web.data.epochMillisToIso
import com.tribetails.auntieos.web.data.toBreadcrumbs
import com.tribetails.auntieos.web.screens.sessions.durationMillis
import com.tribetails.auntieos.web.screens.sessions.formatDistance
import com.tribetails.auntieos.web.screens.sessions.formatDuration
import com.tribetails.auntieos.web.screens.sessions.totalDistanceMeters
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Slice 5 unit tests: the GpsSummary -> Breadcrumb adapter feeding the shared
 * RouteMap, plus the RouteMap geo/time helpers run against the adapted points.
 * These are pure JVM and cover the GPS-stats half of the slice (the SENT report
 * + composer route stats). No network, no Compose.
 */
class GpsSummaryAdapterTest {

    // ── epochMillisToIso (inverse of RouteMap.parseIsoMillis) ────────────────

    @Test
    fun epochMillisToIsoEpochZeroIsUnixOrigin() {
        assertEquals("1970-01-01T00:00:00Z", epochMillisToIso(0L))
    }

    @Test
    fun epochMillisToIsoKnownInstantRoundTrips() {
        // 2026-06-04T12:34:56Z -> compute via the same civil math.
        // 1780576496000 ms == 2026-06-04T12:34:56Z
        assertEquals("2026-06-04T12:34:56Z", epochMillisToIso(1_780_576_496_000L))
    }

    @Test
    fun epochMillisToIsoIsParsedBackToSameDurationDelta() {
        val start = 1_780_576_496_000L
        val end = start + 32 * 60 * 1_000L // +32 minutes
        val crumbs = listOf(
            GpsPoint(lat = 30.0, lng = -97.0, t = start),
            GpsPoint(lat = 30.001, lng = -97.001, t = end),
        ).let { GpsSummary(route = it).toBreadcrumbs() }
        // 32 minutes in millis
        assertEquals(32 * 60 * 1_000L, durationMillis(crumbs))
        assertEquals("32m 0s", formatDuration(durationMillis(crumbs)))
    }

    // ── toBreadcrumbs mapping ────────────────────────────────────────────────

    @Test
    fun emptyRouteMapsToEmptyList() {
        assertTrue(GpsSummary(route = emptyList()).toBreadcrumbs().isEmpty())
    }

    @Test
    fun singlePointMapsLatLngAndTimestamp() {
        val bc = GpsSummary(route = listOf(GpsPoint(lat = 30.25, lng = -97.75, t = 1_000L)))
            .toBreadcrumbs()
        assertEquals(1, bc.size)
        assertEquals(30.25, bc[0].lat, 1e-9)
        assertEquals(-97.75, bc[0].lng, 1e-9)
        assertEquals("1970-01-01T00:00:01Z", bc[0].timestamp)
    }

    @Test
    fun zeroTimestampMapsToBlankSoDurationDegradesNotFaked() {
        // Older summaries with t == 0 must NOT fabricate a duration: blank
        // timestamp -> RouteMap shows "-".
        val bc = GpsSummary(
            route = listOf(
                GpsPoint(lat = 30.0, lng = -97.0, t = 0L),
                GpsPoint(lat = 30.01, lng = -97.0, t = 0L),
            ),
        ).toBreadcrumbs()
        assertEquals("", bc[0].timestamp)
        assertEquals(0L, durationMillis(bc))
        assertEquals("-", formatDuration(durationMillis(bc)))
    }

    // ── distance/duration against adapted points ─────────────────────────────

    @Test
    fun twoPointDistanceIsNonZeroAndFormatted() {
        // Two points ~111m apart in latitude (0.001 deg ~= 111m).
        val bc = GpsSummary(
            route = listOf(
                GpsPoint(lat = 30.0000, lng = -97.0, t = 1_000_000L),
                GpsPoint(lat = 30.0010, lng = -97.0, t = 1_060_000L),
            ),
        ).toBreadcrumbs()
        val meters = totalDistanceMeters(bc)
        assertTrue(meters in 100.0..120.0, "expected ~111m, got $meters")
        assertEquals("111 m", formatDistance(meters))
        assertEquals("1m 0s", formatDuration(durationMillis(bc)))
    }

    @Test
    fun singlePointHasZeroDistanceAndDuration() {
        val bc = GpsSummary(route = listOf(GpsPoint(lat = 30.0, lng = -97.0, t = 5_000L)))
            .toBreadcrumbs()
        assertEquals(0.0, totalDistanceMeters(bc), 1e-9)
        assertEquals(0L, durationMillis(bc))
    }
}
