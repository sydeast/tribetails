package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.LocationPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * #2338 / #2386 ruling: the Arrived card's GPS line on the phone. "GPS
 * tracking · live route" with the live dot when this phone is the tracker or
 * the route has a ping from the last [LIVE_PING_WINDOW_MS]; otherwise the last
 * ping and its time, or that none has landed.
 */
class GpsLineTest {
    private val chicago = ZoneId.of("America/Chicago")

    // 2026-11-17 20:05 UTC is 14:05 in Chicago.
    private val at = 1_794_945_900_000L

    private fun crumb(t: Long) = LocationPoint(latitude = 30.0, longitude = -97.0, timestamp = t)

    @Test
    fun `a ping inside the window reads as a live route with the dot`() {
        val line = gpsLineFor(false, listOf(crumb(at - 60_000), crumb(at)), chicago, nowMs = at + LIVE_PING_WINDOW_MS)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }

    @Test
    fun `a ping just outside the window names the last ping with no dot`() {
        val line = gpsLineFor(false, listOf(crumb(at)), chicago, nowMs = at + LIVE_PING_WINDOW_MS + 1)!!
        assertEquals("GPS route · last ping 14:05", line.text)
        assertFalse(line.live)
    }

    @Test
    fun `the same crumbs flip to the last ping as time passes with no new one`() {
        val crumbs = listOf(crumb(at))
        assertTrue(gpsLineFor(false, crumbs, chicago, nowMs = at + 30_000)!!.live)
        assertFalse(gpsLineFor(false, crumbs, chicago, nowMs = at + 15 * 60_000)!!.live)
    }
    @Test
    fun `the window is ten minutes, live at exactly 10 00 after the last ping and not a millisecond later`() {
        assertEquals(600_000L, LIVE_PING_WINDOW_MS)
        val crumbs = listOf(crumb(at))
        assertTrue(gpsLineFor(false, crumbs, chicago, nowMs = at + 9 * 60_000 + 59_000)!!.live)
        assertEquals(GpsLine("GPS tracking · live route", live = true), gpsLineFor(false, crumbs, chicago, nowMs = at + 600_000))
        assertEquals(GpsLine("GPS route · last ping 14:05", live = false), gpsLineFor(false, crumbs, chicago, nowMs = at + 600_001))
    }
    @Test
    fun `an Auntie sitting still with a Kin for six minutes, no ping under 5 m, still reads live`() {
        val line = gpsLineFor(false, listOf(crumb(at - 30_000), crumb(at)), chicago, nowMs = at + 6 * 60_000)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }

    @Test
    fun `a ping stamped a little ahead of this clock still counts as recent`() {
        assertTrue(gpsLineFor(false, listOf(crumb(at + 20_000)), chicago, nowMs = at)!!.live)
    }

    @Test
    fun `after an undo the route from before Departed stops reading live once it ages out`() {
        // Departed at 14:05 with the last ping, undone a minute later, nothing tracking since.
        val crumbs = listOf(crumb(at - 30_000), crumb(at))
        val line = gpsLineFor(false, crumbs, chicago, nowMs = at + LIVE_PING_WINDOW_MS + 60_000)!!
        assertEquals("GPS route · last ping 14:05", line.text)
        assertFalse(line.live)
    }

    @Test
    fun `no pings yet, loading, and an undated route`() {
        assertEquals("No GPS pings yet", gpsLineFor(false, emptyList(), chicago, at)?.text)
        assertNull(gpsLineFor(false, null, chicago, at))
        val undated = gpsLineFor(false, listOf(crumb(0L)), chicago, at)!!
        assertEquals("GPS route recorded", undated.text)
        assertFalse(undated.live)
    }

    @Test
    fun `this phone tracking is live before any ping lands`() {
        val line = gpsLineFor(trackingHere = true, crumbs = null, zone = chicago, nowMs = at)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }
}
