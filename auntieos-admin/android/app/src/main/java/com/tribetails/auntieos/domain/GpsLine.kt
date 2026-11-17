package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.LocationPoint
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * #2338: the Arrived card's GPS line, and whether it carries the live dot.
 *
 * It used to read "GPS tracking · live route" on every Arrived card. After
 * "Undo departed" a visit is Arrived again with no device tracking it, and the
 * line was false. A card can only know two things: whether THIS phone is the
 * tracker, and what the visit's breadcrumbs hold. So it says the first when it
 * is true, and otherwise when the route last pinged, or that none has landed.
 * The same words as admin web (`components/VisitTrackingIndicator.tsx`) and
 * the desktop console (`screens/sessions/GpsLine.kt`).
 */
data class GpsLine(val text: String, val live: Boolean)

private val HH_MM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

/**
 * PURE.
 *
 * @param crumbs the visit's breadcrumbs, or null while they load or when the
 *        read failed: the card then says nothing rather than guess.
 */
fun gpsLineFor(trackingHere: Boolean, crumbs: List<LocationPoint>?, zone: ZoneId): GpsLine? {
    if (trackingHere) return GpsLine("GPS tracking · live route", live = true)
    if (crumbs == null) return null
    if (crumbs.isEmpty()) return GpsLine("No GPS pings yet", live = false)
    val last = crumbs.maxOf { it.timestamp }
    if (last <= 0L) return GpsLine("GPS route recorded", live = false)
    return GpsLine("GPS route · last ping ${HH_MM.format(Instant.ofEpochMilli(last).atZone(zone))}", live = false)
}
