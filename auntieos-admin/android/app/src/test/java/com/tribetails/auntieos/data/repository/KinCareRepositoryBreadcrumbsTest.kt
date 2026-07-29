package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.model.LocationPoint
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-helper TDD for breadcrumbs subcollection sort ordering.
 *
 * The `addBreadcrumb` / `getBreadcrumbs` / `observeBreadcrumbs` methods on
 * `KinCareRepository` (W4-3; they read and write the `breadcrumbs`
 * subcollection of a kin-care session doc) rely on
 * `breadcrumbsOrderedByTimestamp` to enforce a
 * deterministic ascending order on `LocationPoint.timestamp`. Firestore
 * `orderBy("timestamp")` enforces the same order server-side, but client-side
 * sort is the single source of truth for any in-memory list (e.g.
 * snapshot listeners returning out-of-order pending writes, batched seeds).
 *
 * Robolectric/Firebase mocking is intentionally avoided here - see project
 * memory `[[compose-pure-helper-tdd]]`. Suspend methods that hit Firestore
 * are validated end-to-end via instrumented tests or manual QA; the pure
 * sort helper is what we lock down here.
 *
 * Decision: points with `timestamp == 0L` (blank/unset) sort FIRST. Rationale:
 * a zero timestamp means "unknown" and the only natural numeric position for
 * unknown values is the head - matching Firestore's own `orderBy` semantics
 * for numeric fields with default values.
 */
class KinCareRepositoryBreadcrumbsTest {

    @Test
    fun `empty list returns empty list`() {
        val result = breadcrumbsOrderedByTimestamp(emptyList())
        assertEquals(emptyList<LocationPoint>(), result)
    }

    @Test
    fun `already sorted ascending stays same order`() {
        val points = listOf(
            LocationPoint(latitude = 1.0, longitude = 1.0, timestamp = 1L),
            LocationPoint(latitude = 2.0, longitude = 2.0, timestamp = 2L),
            LocationPoint(latitude = 3.0, longitude = 3.0, timestamp = 3L),
        )
        val result = breadcrumbsOrderedByTimestamp(points)
        assertEquals(listOf(1L, 2L, 3L), result.map { it.timestamp })
    }

    @Test
    fun `unsorted 3-1-2 sorts to 1-2-3 ascending`() {
        val points = listOf(
            LocationPoint(latitude = 3.0, longitude = 3.0, timestamp = 3L),
            LocationPoint(latitude = 1.0, longitude = 1.0, timestamp = 1L),
            LocationPoint(latitude = 2.0, longitude = 2.0, timestamp = 2L),
        )
        val result = breadcrumbsOrderedByTimestamp(points)
        assertEquals(listOf(1L, 2L, 3L), result.map { it.timestamp })
        // Preserve latitude pairing to confirm we sort the whole object, not just timestamps.
        assertEquals(listOf(1.0, 2.0, 3.0), result.map { it.latitude })
    }

    @Test
    fun `blank timestamps (0L) sort first`() {
        val points = listOf(
            LocationPoint(latitude = 5.0, longitude = 5.0, timestamp = 5L),
            LocationPoint(latitude = 9.0, longitude = 9.0, timestamp = 0L), // blank
            LocationPoint(latitude = 1.0, longitude = 1.0, timestamp = 1L),
        )
        val result = breadcrumbsOrderedByTimestamp(points)
        assertEquals(listOf(0L, 1L, 5L), result.map { it.timestamp })
    }
}
