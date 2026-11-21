package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.Breadcrumb
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.datetime.TimeZone

/**
 * #2338 / #2386 ruling: the Arrived card's GPS line on the console. "GPS
 * tracking · live route" with the live dot while the route has a ping from the
 * last [LIVE_PING_WINDOW_MS]; otherwise the last ping and its time, or that
 * none has landed.
 */
class GpsLineTest {
    private val chicago = TimeZone.of("America/Chicago")

    // 2026-11-17 20:05 UTC is 14:05 in Chicago.
    private val at = 1_794_945_900_000L

    private val crumbs = listOf(
        Breadcrumb(timestamp = (at - 60_000).toString()),
        Breadcrumb(timestamp = at.toString()),
        Breadcrumb(timestamp = "2026-11-17T20:00:00Z"),
    )

    @Test
    fun aPingInsideTheWindowReadsAsALiveRouteWithTheDot() {
        val line = gpsLineFor(trackingHere = false, crumbs = crumbs, zone = chicago, nowMs = at + LIVE_PING_WINDOW_MS)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }

    @Test
    fun aPingJustOutsideTheWindowNamesTheLastPingInTwentyFourHoursWithNoDot() {
        val line = gpsLineFor(trackingHere = false, crumbs = crumbs, zone = chicago, nowMs = at + LIVE_PING_WINDOW_MS + 1)!!
        assertEquals("GPS route · last ping 14:05", line.text)
        assertFalse(line.live)
    }

    @Test
    fun theSameCrumbsFlipToTheLastPingAsTimePassesWithNoNewOne() {
        assertTrue(gpsLineFor(false, crumbs, chicago, nowMs = at + 30_000)!!.live)
        assertFalse(gpsLineFor(false, crumbs, chicago, nowMs = at + 15 * 60_000)!!.live)
    }
    @Test
    fun theWindowIsTenMinutesLiveAtExactlyTenAfterTheLastPingAndNotAMillisecondLater() {
        assertEquals(600_000L, LIVE_PING_WINDOW_MS)
        val one = listOf(Breadcrumb(timestamp = at.toString()))
        assertTrue(gpsLineFor(false, one, chicago, nowMs = at + 9 * 60_000 + 59_000)!!.live)
        assertEquals(GpsLine("GPS tracking · live route", live = true), gpsLineFor(false, one, chicago, nowMs = at + 600_000))
        assertEquals(GpsLine("GPS route · last ping 14:05", live = false), gpsLineFor(false, one, chicago, nowMs = at + 600_001))
    }
    @Test
    fun anAuntieSittingStillWithAKinForSixMinutesStillReadsLive() {
        val line = gpsLineFor(false, crumbs, chicago, nowMs = at + 6 * 60_000)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }

    @Test
    fun anIsoPingCountsAsRecentToo() {
        val iso = listOf(Breadcrumb(timestamp = "2026-11-17T20:05:00Z"))
        assertTrue(gpsLineFor(false, iso, chicago, nowMs = at + 60_000)!!.live)
    }

    @Test
    fun aPingStampedALittleAheadOfThisClockStillCountsAsRecent() {
        assertTrue(gpsLineFor(false, listOf(Breadcrumb(timestamp = (at + 20_000).toString())), chicago, nowMs = at)!!.live)
    }

    @Test
    fun saysNoPingsYetRatherThanALiveRoute() {
        assertEquals("No GPS pings yet", gpsLineFor(false, emptyList(), chicago, at)?.text)
    }

    @Test
    fun saysNothingWhileLoadingOrWhenTheReadFailed() {
        assertNull(gpsLineFor(false, null, chicago, at))
    }

    @Test
    fun anUndatedRouteIsStillARecordedRoute() {
        val line = gpsLineFor(false, listOf(Breadcrumb(timestamp = "")), chicago, at)!!
        assertEquals("GPS route recorded", line.text)
        assertFalse(line.live)
    }

    @Test
    fun liveWhenThisDeviceIsTheTracker() {
        val line = gpsLineFor(trackingHere = true, crumbs = null, zone = chicago, nowMs = at)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }
}
