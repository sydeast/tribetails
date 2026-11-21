package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.LocationPoint
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * #2338 / #2386: the Arrived card's GPS line, and whether it carries the live dot.
 *
 * The mock's line is "GPS tracking · live route" with a pulsing dot, and the
 * operator ruled (#2386) that it reads that while an Auntie's phone is
 * tracking the visit. A card cannot see another phone, so "tracking" is read
 * from what it can see:
 *   - THIS phone is the tracker: live.
 *   - the visit's route has a ping from the last [LIVE_PING_WINDOW_MS] (a
 *     ping a little ahead of this clock counts too): live. A tracking phone
 *     writes one about every five seconds while it moves five metres or more.
 *   - otherwise when the route last pinged, or that none has landed, with no
 *     dot. This is what a visit put back to Arrived by "Undo departed" shows
 *     once nothing is tracking it, and also what a phone that has sat still
 *     for longer than the window shows, because it writes no ping then.
 * The same words and window as admin web (`components/VisitTrackingIndicator.tsx`)
 * and the desktop console (`screens/sessions/GpsLine.kt`).
 */
data class GpsLine(val text: String, val live: Boolean)

/** #2386: a ping this recent means a phone is tracking the visit. Two minutes. */
const val LIVE_PING_WINDOW_MS: Long = 2 * 60_000L

/** How often an Arrived card reads the clock again, so "live" ages out with no new ping. */
const val GPS_LINE_TICK_MS: Long = 15_000L

private val HH_MM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

private val LIVE = GpsLine("GPS tracking · live route", live = true)

/**
 * PURE.
 *
 * @param crumbs the visit's breadcrumbs, or null while they load or when the
 *        read failed: the card then says nothing rather than guess.
 * @param nowMs this device's clock, read again every [GPS_LINE_TICK_MS].
 */
fun gpsLineFor(trackingHere: Boolean, crumbs: List<LocationPoint>?, zone: ZoneId, nowMs: Long): GpsLine? {
    if (trackingHere) return LIVE
    if (crumbs == null) return null
    if (crumbs.isEmpty()) return GpsLine("No GPS pings yet", live = false)
    val last = crumbs.maxOf { it.timestamp }
    if (last <= 0L) return GpsLine("GPS route recorded", live = false)
    if (nowMs - last <= LIVE_PING_WINDOW_MS) return LIVE
    return GpsLine("GPS route · last ping ${HH_MM.format(Instant.ofEpochMilli(last).atZone(zone))}", live = false)
}
