package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.config.MapboxConfig
import com.tribetails.auntieos.data.model.GpsPoint
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Pure-helper tests for the Kin Care route map (#760). No Android runtime, no
 * Mapbox, per [[compose-pure-helper-tdd]].
 *
 * These lock the SAME wording the web admin's `lib/routeHeader.ts` produces,
 * because the point of the ruling is that one visit reads the same on the phone
 * and on the desk. If one of these strings changes, the other platform's spec
 * has to change with it.
 *
 * Every stamp here is a naive LOCAL instant with no trailing Z, matching how
 * `KinCareDetailScreen.shortIso` already treats these fields, so nothing here
 * depends on the machine's zone.
 */
class KinCareRouteMapHelpersTest {

    private fun localMillis(iso: String): Long =
        LocalDateTime.parse(iso).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()

    private val now = localMillis("2026-09-11T12:00:00")

    @Test
    fun `clock duration drops seconds rather than rounding up`() {
        assertEquals("1:04", formatClockDuration(3_852))
        assertEquals("1:04", formatClockDuration(3_899))
        assertEquals("0:00", formatClockDuration(45))
        assertEquals("10:00", formatClockDuration(36_000))
    }

    @Test
    fun `an unknown visit length has no clause at all`() {
        assertEquals("", formatClockDuration(0))
        assertEquals("", formatClockDuration(-5))
    }

    @Test
    fun `distance reads in miles, truncated so it never claims unwalked ground`() {
        assertEquals("0.1 miles", formatMiles(200.0))
        assertEquals("0.9 miles", formatMiles(1_609.0))
        assertEquals("1.0 miles", formatMiles(1_610.0))
        assertEquals("0 miles", formatMiles(0.0))
    }

    @Test
    fun `clock time reads noon as 12pm and midnight as 12am`() {
        assertEquals("12:05pm", clockTime("2026-08-11T12:05:00"))
        assertEquals("9:01am", clockTime("2026-08-11T09:01:00"))
        assertEquals("1:09pm", clockTime("2026-08-11T13:09:00"))
        assertEquals("12:00am", clockTime("2026-08-11T00:00:00"))
    }

    @Test
    fun `a blank or unparseable stamp prints nothing, never Invalid Date`() {
        assertEquals("", clockTime(""))
        assertEquals("", clockTime(null))
        assertEquals("", clockTime("whenever"))
    }

    @Test
    fun `relative age reads in the coarsest unit that still says something`() {
        assertEquals("just now", relativeAge("2026-09-11T11:59:40", now))
        assertEquals("1 minute ago", relativeAge("2026-09-11T11:59:00", now))
        assertEquals("30 minutes ago", relativeAge("2026-09-11T11:30:00", now))
        assertEquals("2 hours ago", relativeAge("2026-09-11T10:00:00", now))
        assertEquals("6 days ago", relativeAge("2026-09-05T12:00:00", now))
        assertEquals("1 month ago", relativeAge("2026-08-09T12:00:00", now))
    }

    /**
     * A visit that has not happened has no route to draw, so a stamp ahead of
     * now is clock skew or a bad document. "in -3 days" is not a fact worth
     * printing over a map.
     */
    @Test
    fun `a stamp in the future has no age`() {
        assertEquals("", relativeAge("2026-09-12T12:00:00", now))
    }

    @Test
    fun `the strip states the visit length, both clock times and the distance`() {
        val strip = routeHeaderStrip(
            arrivedAt = "2026-08-11T12:05:00",
            departedAt = "2026-08-11T13:09:00",
            distanceMeters = 200.0,
            durationSeconds = 3_852L,
            nowMillis = now,
        )
        assertEquals("Completed in 1:04", strip.lead)
        assertEquals("Arrived at 12:05pm - Departed at 1:09pm - 0.1 miles", strip.detail)
        assertEquals("1 month ago", strip.age)
    }

    /**
     * DEPARTED IS NOT COMPLETED. The reference report writes "Completed at" over
     * `departedAt`; this screen prints the real completion stamp in its
     * Lifecycle section directly above, so borrowing that word here would put
     * two different completion times on one screen.
     */
    @Test
    fun `the strip names the departure as a departure`() {
        val strip = routeHeaderStrip(
            arrivedAt = "2026-08-11T12:05:00",
            departedAt = "2026-08-11T13:09:00",
            distanceMeters = null,
            durationSeconds = null,
            nowMillis = now,
        )
        assertEquals(true, strip.detail.contains("Departed at 1:09pm"))
        assertEquals(false, strip.detail.contains("Completed at"))
    }

    @Test
    fun `the strip measures from the two stamps when no GPS summary carries a duration`() {
        val strip = routeHeaderStrip(
            arrivedAt = "2026-08-11T12:05:00",
            departedAt = "2026-08-11T13:09:00",
            distanceMeters = null,
            durationSeconds = null,
            nowMillis = now,
        )
        assertEquals("Completed in 1:04", strip.lead)
    }

    @Test
    fun `the strip drops the clauses a live visit does not have yet`() {
        val strip = routeHeaderStrip(
            arrivedAt = "2026-09-11T11:30:00",
            departedAt = "",
            distanceMeters = 200.0,
            durationSeconds = null,
            nowMillis = now,
        )
        assertEquals("", strip.lead)
        assertEquals("Arrived at 11:30am - 0.1 miles", strip.detail)
        assertEquals("30 minutes ago", strip.age)
    }

    /**
     * The departure stamp is the gate on the length, not merely the source of
     * it. Printing "Completed in 0:07" over a walk the Auntie is in the middle
     * of would state a completion that has not happened, directly under a
     * Lifecycle section showing Departed and Completed as still empty.
     */
    @Test
    fun `the strip reports no length for a visit with no departure stamp`() {
        val strip = routeHeaderStrip(
            arrivedAt = "2026-09-11T11:30:00",
            departedAt = "",
            distanceMeters = 200.0,
            durationSeconds = 420L,
            nowMillis = now,
        )
        assertEquals("", strip.lead)
        assertEquals("Arrived at 11:30am - 0.1 miles", strip.detail)
    }

    @Test
    fun `a visit with nothing on file leaves every clause out`() {
        val strip = routeHeaderStrip(null, null, null, null, now)
        assertEquals(RouteHeaderStrip("", "", ""), strip)
    }

    @Test
    fun `the household coordinate is read off the stored serviceLocation`() {
        val point = readHouseholdServiceLocation(
            mapOf("serviceLocation" to mapOf("lat" to 34.2712, "lng" to -119.2264)),
        )
        assertEquals(HouseholdPoint(34.2712, -119.2264), point)
    }

    /**
     * NULL ISLAND IS THE ONE THAT LOOKS VALID. `0, 0` is a real coordinate in
     * the Gulf of Guinea and also what a half-written document holds, and a
     * house marker three thousand miles off the route would read as a tracking
     * failure rather than as a missing field.
     */
    @Test
    fun `a zero-zero coordinate draws no house`() {
        assertNull(readHouseholdServiceLocation(mapOf("serviceLocation" to mapOf("lat" to 0.0, "lng" to 0.0))))
    }

    @Test
    fun `an absent, partial or off-globe coordinate draws no house`() {
        assertNull(readHouseholdServiceLocation(null))
        assertNull(readHouseholdServiceLocation(mapOf("serviceAddress" to "12 Alder St")))
        assertNull(readHouseholdServiceLocation(mapOf("serviceLocation" to mapOf("lat" to 34.2712))))
        assertNull(readHouseholdServiceLocation(mapOf("serviceLocation" to "34.2712,-119.2264")))
        assertNull(
            readHouseholdServiceLocation(mapOf("serviceLocation" to mapOf("lat" to 134.2, "lng" to -119.2))),
        )
    }

    /**
     * `MapboxConfig.resetForTests` is process-wide mutable state in a
     * single-JVM suite, which is what cost this codebase issue #425, so it is
     * restored whatever the three cases below do.
     */
    @After
    fun restoreMapboxConfig() = MapboxConfig.resetForTests()

    /**
     * THE THIRD FALLBACK CONDITION, and the one a boolean could not have
     * carried. `applyAccessToken` records `Delivered(token, deliveryError)`
     * when the native handover throws, which is an `UnsatisfiedLinkError` on
     * any device or JVM whose Mapbox native library did not load. Startup was
     * willing and there is still no usable credential, so the Kin Care detail
     * has to draw the Canvas polyline rather than build a MapView that cannot
     * work. The web admin's equivalent is mapbox-gl throwing in the
     * constructor after `canRenderMapboxMap()` already said yes.
     */
    @Test
    fun `a token the SDK refused does not count as a token`() {
        MapboxConfig.resetForTests { throw UnsatisfiedLinkError("no mapbox native library here") }
        MapboxConfig.applyAccessToken("pk.example-not-a-real-token")
        assertFalse(hasMapboxToken())
    }

    @Test
    fun `a token the SDK took does count`() {
        MapboxConfig.resetForTests { }
        MapboxConfig.applyAccessToken("pk.example-not-a-real-token")
        assertTrue(hasMapboxToken())
    }

    @Test
    fun `a build with no token at all falls back without ever asking the SDK`() {
        var handed = false
        MapboxConfig.resetForTests { handed = true }
        MapboxConfig.applyAccessToken("")
        assertFalse(hasMapboxToken())
        assertFalse(handed)
    }

    /**
     * The camera has to hold the house as well as the trail. How far the walk
     * ran from the home it belongs to is what this panel is read for, and a fit
     * to the trail alone crops the house out exactly when it is furthest away.
     */
    @Test
    fun `the camera points include the household when there is one`() {
        val trail = listOf(GpsPoint(lat = 34.2746, lng = -119.229), GpsPoint(lat = 34.2781, lng = -119.2331))
        assertEquals(2, cameraPoints(trail, null).size)

        val withHouse = cameraPoints(trail, HouseholdPoint(34.2712, -119.2264))
        assertEquals(3, withHouse.size)
        assertEquals(34.2712, withHouse.last().latitude, 1e-9)
        assertEquals(-119.2264, withHouse.last().longitude, 1e-9)
    }
}
