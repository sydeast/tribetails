package com.tribetails.auntieos.ui.components

import com.tribetails.auntieos.data.model.GpsPoint
import com.tribetails.auntieos.data.model.LocationPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure geo-math tests for RouteMap helpers. No Compose, no Android runtime.
 */
class RouteMapTest {

    // ---- totalDistanceMeters ----

    @Test
    fun `totalDistanceMeters returns 0 for empty list`() {
        assertEquals(0.0, totalDistanceMeters(emptyList()), 0.0)
    }

    @Test
    fun `totalDistanceMeters returns 0 for single point`() {
        val one = listOf(GpsPoint(lat = 40.0, lng = -75.0, t = 0L))
        assertEquals(0.0, totalDistanceMeters(one), 0.0)
    }

    @Test
    fun `totalDistanceMeters approximates haversine for two points 1km apart`() {
        // ~0.009 deg latitude ≈ 1 km at the equator
        val pts = listOf(
            GpsPoint(lat = 0.0, lng = 0.0, t = 0L),
            GpsPoint(lat = 0.009, lng = 0.0, t = 0L),
        )
        val d = totalDistanceMeters(pts)
        assertTrue("expected ~1000m, got $d", d in 990.0..1010.0)
    }

    @Test
    fun `totalDistanceMeters sums consecutive segments`() {
        val pts = listOf(
            GpsPoint(lat = 0.0,   lng = 0.0, t = 0L),
            GpsPoint(lat = 0.009, lng = 0.0, t = 0L),
            GpsPoint(lat = 0.018, lng = 0.0, t = 0L),
        )
        val d = totalDistanceMeters(pts)
        assertTrue("expected ~2000m, got $d", d in 1990.0..2020.0)
    }

    // ---- formatDistance ----

    @Test
    fun `formatDistance under 1m shows 0 m`() {
        assertEquals("0 m", formatDistance(0.4))
    }

    @Test
    fun `formatDistance under 1km shows whole meters`() {
        assertEquals("250 m", formatDistance(250.7))
    }

    @Test
    fun `formatDistance over 1km shows tenths km`() {
        assertEquals("1.5 km", formatDistance(1_512.0))
    }

    // ---- durationMillis ----

    @Test
    fun `durationMillis returns 0 for empty list`() {
        assertEquals(0L, durationMillis(emptyList()))
    }

    @Test
    fun `durationMillis returns 0 when t is unknown (0)`() {
        val pts = listOf(
            GpsPoint(lat = 0.0, lng = 0.0, t = 0L),
            GpsPoint(lat = 0.0, lng = 0.0, t = 5_000L),
        )
        // First point's t is 0 = unknown sentinel → return 0
        assertEquals(0L, durationMillis(pts))
    }

    @Test
    fun `durationMillis returns last minus first`() {
        val pts = listOf(
            GpsPoint(lat = 0.0, lng = 0.0, t = 1_000L),
            GpsPoint(lat = 0.0, lng = 0.0, t = 4_500L),
        )
        assertEquals(3_500L, durationMillis(pts))
    }

    @Test
    fun `durationMillis clamps negative to 0`() {
        val pts = listOf(
            GpsPoint(lat = 0.0, lng = 0.0, t = 5_000L),
            GpsPoint(lat = 0.0, lng = 0.0, t = 1_000L),
        )
        assertEquals(0L, durationMillis(pts))
    }

    // ---- formatDuration ----

    @Test
    fun `formatDuration zero shows em dash`() {
        assertEquals("-", formatDuration(0L))
    }

    @Test
    fun `formatDuration seconds`() {
        assertEquals("45s", formatDuration(45_000L))
    }

    @Test
    fun `formatDuration minutes and seconds`() {
        assertEquals("3m 12s", formatDuration(192_000L))
    }

    @Test
    fun `formatDuration hours and minutes`() {
        assertEquals("2h 5m", formatDuration(7_500_000L))
    }

    // ---- locationPointToGpsPoint ----

    @Test
    fun `locationPointToGpsPoint maps lat lng timestamp straight through`() {
        val lp = LocationPoint(
            latitude = 40.0,
            longitude = -75.0,
            timestamp = 1_000_000L,
        )
        val gp = locationPointToGpsPoint(lp)
        assertEquals(40.0, gp.lat, 0.0)
        assertEquals(-75.0, gp.lng, 0.0)
        assertEquals(1_000_000L, gp.t)
    }

    @Test
    fun `locationPointToGpsPoint ignores altitude accuracy speed bearing`() {
        val lp = LocationPoint(
            latitude = 12.34,
            longitude = 56.78,
            altitude = 999.0,
            accuracy = 5.0f,
            timestamp = 42L,
            speed = 3.2f,
            bearing = 180f,
        )
        val gp = locationPointToGpsPoint(lp)
        assertEquals(12.34, gp.lat, 0.0)
        assertEquals(56.78, gp.lng, 0.0)
        assertEquals(42L, gp.t)
    }

    @Test
    fun `locationPointToGpsPoint default LocationPoint maps structurally`() {
        // Default LocationPoint() stamps timestamp = System.currentTimeMillis().
        // Verify structural mapping not the exact wall-clock value.
        val before = System.currentTimeMillis()
        val lp = LocationPoint()
        val after = System.currentTimeMillis()
        val gp = locationPointToGpsPoint(lp)
        assertEquals(0.0, gp.lat, 0.0)
        assertEquals(0.0, gp.lng, 0.0)
        assertTrue(
            "expected t in [$before, $after], got ${gp.t}",
            gp.t in before..after,
        )
    }
}
