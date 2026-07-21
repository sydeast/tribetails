package com.tribetails.auntieos.ui.location

import com.tribetails.auntieos.data.model.CheckpointType
import com.tribetails.auntieos.data.model.LocationCheckpoint
import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.model.VisitRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for RouteViewerScreen.kt - no Android runtime, no Mapbox.
 * Covers the share-summary formatter and the checkpoint color map. Per
 * [[compose-pure-helper-tdd]] decision logic lives in top-level helpers so
 * the formatting contract can be locked under JVM unit tests.
 */
class RouteViewerHelpersTest {

    @Test
    fun `checkpoint color hex maps START to kinfolk gold`() {
        assertEquals("#C8A96E", checkpointColorHex(CheckpointType.START))
    }

    @Test
    fun `checkpoint color hex maps ARRIVAL to success green`() {
        assertEquals("#3CB371", checkpointColorHex(CheckpointType.ARRIVAL))
    }

    @Test
    fun `checkpoint color hex maps WAYPOINT to dim grey`() {
        assertEquals("#9CA3AF", checkpointColorHex(CheckpointType.WAYPOINT))
    }

    @Test
    fun `checkpoint color hex maps PHOTO_STOP to kinfolk gold`() {
        assertEquals("#C8A96E", checkpointColorHex(CheckpointType.PHOTO_STOP))
    }

    @Test
    fun `checkpoint color hex maps DEPARTURE to dim grey`() {
        assertEquals("#9CA3AF", checkpointColorHex(CheckpointType.DEPARTURE))
    }

    @Test
    fun `checkpoint color hex maps END to kinfolk gold`() {
        assertEquals("#C8A96E", checkpointColorHex(CheckpointType.END))
    }

    @Test
    fun `share summary includes kinfolk name in first line`() {
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(),
            checkpoints = emptyList(),
        )
        assertTrue(out.startsWith("Visit Route: Bailey"))
    }

    @Test
    fun `share summary converts meters to km with two decimals`() {
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(totalDistance = 1234.5),
            checkpoints = emptyList(),
        )
        assertTrue("expected '1.23 km' in output, got:\n$out", out.contains("1.23 km"))
    }

    @Test
    fun `share summary converts duration ms to minutes`() {
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            // 4 minutes 30 seconds = 270_000 ms → floor to 4 min
            route       = VisitRoute(totalDuration = 270_000L),
            checkpoints = emptyList(),
        )
        assertTrue("expected '4 min' in output, got:\n$out", out.contains("4 min"))
    }

    @Test
    fun `share summary converts m per s to km per h`() {
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(averageSpeed = 1.0), // 3.6 km/h
            checkpoints = emptyList(),
        )
        assertTrue("expected '3.6 km/h' in output, got:\n$out", out.contains("3.6 km/h"))
    }

    @Test
    fun `share summary omits verified line when not visit-verified`() {
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(visitVerified = false),
            checkpoints = emptyList(),
        )
        assertFalse(out.contains("Verified at client home"))
    }

    @Test
    fun `share summary includes verified line when visitVerified true`() {
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(visitVerified = true),
            checkpoints = emptyList(),
        )
        assertTrue(out.contains("Verified at client home: yes"))
    }

    @Test
    fun `share summary lists checkpoints sorted by timestamp`() {
        val later = LocationCheckpoint(
            checkpointType = CheckpointType.ARRIVAL,
            description    = "At door",
            timestamp      = "2026-05-19T15:00:00Z",
        )
        val earlier = LocationCheckpoint(
            checkpointType = CheckpointType.START,
            description    = "Set off",
            timestamp      = "2026-05-19T14:00:00Z",
        )
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(),
            checkpoints = listOf(later, earlier), // intentionally out of order
        )
        val startIndex   = out.indexOf("Set off")
        val arrivalIndex = out.indexOf("At door")
        assertTrue("expected start before arrival, got start=$startIndex, arrival=$arrivalIndex",
            startIndex in 0 until arrivalIndex)
    }

    @Test
    fun `share summary omits checkpoints block when none`() {
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(),
            checkpoints = emptyList(),
        )
        assertFalse(out.contains("Checkpoints"))
    }

    @Test
    fun `share summary renders no-description checkpoint as placeholder`() {
        val cp = LocationCheckpoint(
            checkpointType = CheckpointType.WAYPOINT,
            description    = "",
            timestamp      = "2026-05-19T14:00:00Z",
        )
        val out = buildRouteShareSummary(
            kinfolkName = "Bailey",
            route       = VisitRoute(),
            checkpoints = listOf(cp),
        )
        assertTrue(out.contains("WAYPOINT: (no description)"))
    }
}
