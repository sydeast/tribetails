package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.model.LocationPoint

// ─────────────────────────────────────────────────────────────────────────────
// Pure-helper layer for the breadcrumbs subcollection. Sort ordering lives
// outside AuntieRepository so it's JVM-testable without Firebase deps.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns [points] sorted ascending by [LocationPoint.timestamp].
 *
 * Defensive complement to Firestore's server-side `orderBy("timestamp")`:
 * snapshot listeners deliver cached + pending local writes BEFORE server
 * confirmation, and those pending writes are not guaranteed to be ordered
 * with the server-acked set. Re-sorting client-side guarantees monotonic
 * timestamps for replay rendering even mid-write.
 *
 * Points with `timestamp == 0L` sort FIRST - matches `orderBy` ascending
 * semantics for numeric fields with default zero values.
 */
internal fun breadcrumbsOrderedByTimestamp(points: List<LocationPoint>): List<LocationPoint> =
    points.sortedBy { it.timestamp }
