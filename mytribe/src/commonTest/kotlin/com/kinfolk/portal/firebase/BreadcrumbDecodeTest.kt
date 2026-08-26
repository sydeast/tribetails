package com.kinfolk.portal.firebase

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The Kotlin half of issue #607.
 *
 * `GitliveFirestoreClient.breadcrumbsStream` read `lat` / `lng` and an ISO
 * string, which is the wasm web client's shape, retired in #513. Android writes
 * `latitude` / `longitude` and epoch millis. So the portal's Android and JS
 * builds saw nothing usable in any current visit -- and, worse than the web
 * portal's silent drop, the old code defaulted a missing coordinate to `0.0`,
 * so an Android breadcrumb became a point in the Gulf of Guinea rather than no
 * point at all. A route drawn to null island is a wrong answer presented as a
 * right one.
 *
 * These cases mirror `mytribe/web/src/lib/breadcrumbs.test.ts` and
 * `auntieos-admin/src/lib/breadcrumbs.test.ts`. The three decoders are separate
 * because the readers are in three languages; keeping the cases identical is
 * what stops them drifting.
 */
class BreadcrumbDecodeTest {

    // The case that fails against the pre-#607 decoder.
    @Test
    fun readsTheAndroidShape() {
        assertEquals(
            RoutePointFixture(30.2672, -97.7431, 1_770_000_000_000L),
            decodeBreadcrumb(mapOf("latitude" to 30.2672, "longitude" to -97.7431, "timestamp" to 1_770_000_000_000L))
                .asFixture(),
        )
    }

    @Test
    fun stillReadsTheLegacyWebShape() {
        val decoded = decodeBreadcrumb(
            mapOf("lat" to 30.1, "lng" to -97.7, "timestamp" to "2026-08-24T14:00:00Z"),
        )
        assertEquals(RoutePointFixture(30.1, -97.7, 1_787_580_000_000L), decoded.asFixture())
    }

    /**
     * The null-island bug. Every one of these used to decode to (0.0, 0.0) and
     * be drawn.
     */
    @Test
    fun dropsADocumentWithNoUsableCoordinatePairRatherThanPlottingZeroZero() {
        assertNull(decodeBreadcrumb(emptyMap()))
        assertNull(decodeBreadcrumb(mapOf("lat" to 30.1)))
        assertNull(decodeBreadcrumb(mapOf("latitude" to "30.1", "longitude" to "-97.7")))
        assertNull(decodeBreadcrumb(mapOf("longitude" to -97.7)))
    }

    @Test
    fun keepsAPointWhoseTimestampIsMissingOrUnparseable() {
        assertEquals(
            RoutePointFixture(30.1, -97.7, null),
            decodeBreadcrumb(mapOf("lat" to 30.1, "lng" to -97.7)).asFixture(),
        )
        assertEquals(
            RoutePointFixture(30.1, -97.7, null),
            decodeBreadcrumb(mapOf("latitude" to 30.1, "longitude" to -97.7, "timestamp" to "soon")).asFixture(),
        )
    }

    @Test
    fun isNotFooledByAZeroCoordinateWhichIsARealPlace() {
        assertEquals(
            RoutePointFixture(0.0, 0.0, 5L),
            decodeBreadcrumb(mapOf("lat" to 0.0, "lng" to 0.0, "timestamp" to 5L)).asFixture(),
        )
    }

    /**
     * Gitlive hands a Firestore number back as Long or Double depending on
     * target and on how the value was written, so the decoder reads any
     * `Number` rather than one concrete type.
     */
    @Test
    fun acceptsCoordinatesAndTimestampsAsAnyNumberType() {
        assertEquals(
            RoutePointFixture(30.0, -97.0, 1_770_000_000_000L),
            decodeBreadcrumb(
                mapOf("latitude" to 30, "longitude" to -97, "timestamp" to 1_770_000_000_000.0),
            ).asFixture(),
        )
    }

    @Test
    fun prefersTheShortPairWhenADocumentSomehowCarriesBoth() {
        assertEquals(
            RoutePointFixture(1.0, 2.0, 7L),
            decodeBreadcrumb(
                mapOf("lat" to 1.0, "lng" to 2.0, "latitude" to 30.0, "longitude" to 40.0, "timestamp" to 7L),
            ).asFixture(),
        )
    }

    /**
     * Firestore sorts a mixed-type field by type group first, so a server
     * `orderBy("timestamp")` would return every Android ping before every web
     * one whatever the clock said. Ordering happens on the decoded value.
     */
    @Test
    fun ordersTheTwoWritersByRealTimeNotByStoredType() {
        val points = listOf(
            decodeBreadcrumb(mapOf("lat" to 1.0, "lng" to 1.0, "timestamp" to "2026-08-24T14:00:10Z"))!!,
            decodeBreadcrumb(mapOf("latitude" to 2.0, "longitude" to 2.0, "timestamp" to 1_787_580_005_000L))!!,
            decodeBreadcrumb(mapOf("latitude" to 3.0, "longitude" to 3.0, "timestamp" to 1_787_580_015_000L))!!,
        )
        assertEquals(listOf(2.0, 1.0, 3.0), orderBreadcrumbs(points).map { it.lat })
    }

    @Test
    fun sortsAPointWithNoTimestampToTheFront() {
        val points = listOf(
            decodeBreadcrumb(mapOf("lat" to 1.0, "lng" to 1.0, "timestamp" to 10L))!!,
            decodeBreadcrumb(mapOf("lat" to 2.0, "lng" to 2.0))!!,
        )
        assertEquals(listOf(2.0, 1.0), orderBreadcrumbs(points).map { it.lat })
    }
}

/** Comparable stand-in, so a decode failure prints the coordinates rather than a null. */
private data class RoutePointFixture(val lat: Double, val lng: Double, val t: Long?)

private fun com.kinfolk.portal.components.RoutePoint?.asFixture(): RoutePointFixture? =
    this?.let { RoutePointFixture(it.lat, it.lng, it.t) }
