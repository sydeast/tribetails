package com.tribetails.auntieos.location

import com.tribetails.auntieos.data.model.LocationPoint

/**
 * Pure stats record consumed by LocationTrackingService to populate VisitRoute
 * summary fields (totalDistance/Duration/averageSpeed/maxSpeed) from the
 * in-memory points list. Pure helper so the math is JVM-testable without
 * Firestore or Compose in the loop.
 */
internal data class VisitRouteStats(
    val totalDistanceMeters: Double,
    val totalDurationMs: Long,
    val averageSpeed: Double,
    val maxSpeed: Double,
)

/**
 * Computes summary stats from a list of LocationPoints. Behavior:
 *   - <2 points → zeros
 *   - distance: sum of consecutive [LocationPoint.distanceTo] in meters
 *   - maxSpeed: max of `speed` field across all points
 *   - averageSpeed: mean of `speed` field counting only points where speed > 0
 *   - totalDurationMs: last.timestamp - first.timestamp (signed; matches existing
 *     behavior which doesn't clamp)
 */
internal fun computeVisitRouteStats(points: List<LocationPoint>): VisitRouteStats {
    if (points.size < 2) return VisitRouteStats(0.0, 0L, 0.0, 0.0)

    var distance   = 0.0
    var maxSpd     = 0.0
    var totalSpd   = 0.0
    var speedCount = 0

    for (i in 1 until points.size) {
        val prev = points[i - 1]
        val curr = points[i]
        distance += prev.distanceTo(curr)
        if (curr.speed > maxSpd) maxSpd = curr.speed.toDouble()
        if (curr.speed > 0f) {
            totalSpd  += curr.speed
            speedCount++
        }
    }

    val avg = if (speedCount > 0) totalSpd / speedCount else 0.0
    val duration = points.last().timestamp - points.first().timestamp
    return VisitRouteStats(
        totalDistanceMeters = distance,
        totalDurationMs     = duration,
        averageSpeed        = avg,
        maxSpeed            = maxSpd,
    )
}
