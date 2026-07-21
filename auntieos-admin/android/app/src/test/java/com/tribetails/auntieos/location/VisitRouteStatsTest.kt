package com.tribetails.auntieos.location

import com.tribetails.auntieos.data.model.LocationPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure stats tests for computeVisitRouteStats. No Android runtime, no Firestore.
 * Algorithm is the verbatim extraction of VisitRoute.calculateStats - see
 * VisitRouteStats.kt header.
 */
class VisitRouteStatsTest {

    @Test
    fun `empty list returns all zeros`() {
        val s = computeVisitRouteStats(emptyList())
        assertEquals(0.0, s.totalDistanceMeters, 0.0)
        assertEquals(0L, s.totalDurationMs)
        assertEquals(0.0, s.averageSpeed, 0.0)
        assertEquals(0.0, s.maxSpeed, 0.0)
    }

    @Test
    fun `single point returns all zeros - need 2 for any segment`() {
        val one = listOf(
            LocationPoint(latitude = 0.0, longitude = 0.0, timestamp = 1_000L, speed = 5f),
        )
        val s = computeVisitRouteStats(one)
        assertEquals(0.0, s.totalDistanceMeters, 0.0)
        assertEquals(0L, s.totalDurationMs)
        assertEquals(0.0, s.averageSpeed, 0.0)
        assertEquals(0.0, s.maxSpeed, 0.0)
    }

    @Test
    fun `two points 1km apart computes distance duration and speed stats`() {
        // ~0.009 deg latitude ≈ 1 km at the equator
        val pts = listOf(
            LocationPoint(latitude = 0.0,   longitude = 0.0, timestamp = 0L,      speed = 5f),
            LocationPoint(latitude = 0.009, longitude = 0.0, timestamp = 60_000L, speed = 10f),
        )
        val s = computeVisitRouteStats(pts)
        assertTrue(
            "expected ~1000m, got ${s.totalDistanceMeters}",
            s.totalDistanceMeters in 990.0..1010.0,
        )
        assertEquals(60_000L, s.totalDurationMs)
        // averageSpeed = mean of speeds > 0 across segments i=1..n-1, so only curr=pt[1].speed=10
        // Wait: loop starts at i=1, curr=points[1].speed=10 → speedCount=1, avg=10.0
        // The first point's speed (5f) is never read because curr starts at index 1.
        assertEquals(10.0, s.averageSpeed, 0.0001)
        assertEquals(10.0, s.maxSpeed, 0.0)
    }

    @Test
    fun `three points where one has speed zero only counts non-zero speeds`() {
        val pts = listOf(
            LocationPoint(latitude = 0.0,   longitude = 0.0, timestamp = 0L,       speed = 1f),
            LocationPoint(latitude = 0.001, longitude = 0.0, timestamp = 10_000L,  speed = 0f),
            LocationPoint(latitude = 0.002, longitude = 0.0, timestamp = 20_000L,  speed = 8f),
        )
        val s = computeVisitRouteStats(pts)
        // Loop reads curr=pts[1].speed=0 (skipped) and curr=pts[2].speed=8 (counted)
        // → avg = 8.0 / 1 = 8.0
        assertEquals(8.0, s.averageSpeed, 0.0001)
        assertEquals(8.0, s.maxSpeed, 0.0)
        assertEquals(20_000L, s.totalDurationMs)
    }

    @Test
    fun `backward time yields negative duration - signed matches existing un-clamped behavior`() {
        val pts = listOf(
            LocationPoint(latitude = 0.0,   longitude = 0.0, timestamp = 5_000L, speed = 2f),
            LocationPoint(latitude = 0.001, longitude = 0.0, timestamp = 1_000L, speed = 2f),
        )
        val s = computeVisitRouteStats(pts)
        assertEquals(-4_000L, s.totalDurationMs)
    }
}
