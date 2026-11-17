package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.Breadcrumb
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.datetime.TimeZone

/**
 * #2338: the Arrived card's GPS line on the console. A visit put back to
 * Arrived by Undo departed may have no device tracking it, so the card says
 * when the route last pinged instead of claiming a live route.
 */
class GpsLineTest {
    private val chicago = TimeZone.of("America/Chicago")

    // 2026-11-17 20:05 UTC is 14:05 in Chicago.
    private val at = 1_794_945_900_000L

    @Test
    fun namesTheLastPingInTwentyFourHoursWithNoLiveDot() {
        val crumbs = listOf(
            Breadcrumb(timestamp = (at - 60_000).toString()),
            Breadcrumb(timestamp = at.toString()),
            Breadcrumb(timestamp = "2026-11-17T20:00:00Z"),
        )
        val line = gpsLineFor(trackingHere = false, crumbs = crumbs, zone = chicago)!!
        assertEquals("GPS route · last ping 14:05", line.text)
        assertFalse(line.live)
    }

    @Test
    fun saysNoPingsYetRatherThanALiveRoute() {
        assertEquals("No GPS pings yet", gpsLineFor(false, emptyList(), chicago)?.text)
    }

    @Test
    fun saysNothingWhileLoadingOrWhenTheReadFailed() {
        assertNull(gpsLineFor(false, null, chicago))
    }

    @Test
    fun anUndatedRouteIsStillARecordedRoute() {
        assertEquals("GPS route recorded", gpsLineFor(false, listOf(Breadcrumb(timestamp = "")), chicago)?.text)
    }

    @Test
    fun liveOnlyWhenThisDeviceIsTheTracker() {
        val line = gpsLineFor(trackingHere = true, crumbs = null, zone = chicago)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }
}
