package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.Breadcrumb
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #2338: the Arrived card's GPS line, and whether it carries the live dot.
 *
 * It used to read "GPS tracking · live route" on every Arrived card. After
 * "Undo departed" a visit is Arrived again with no device tracking it, and the
 * line was false. The console never tracks a visit itself (`JvmGpsTracker`),
 * so all it can know is what the visit's breadcrumbs hold: when the route last
 * pinged, or that none has landed. The same words as admin web
 * (`components/VisitTrackingIndicator.tsx`) and Android (`domain/GpsLine.kt`).
 */
internal data class GpsLine(val text: String, val live: Boolean)

/**
 * PURE.
 *
 * @param crumbs the visit's breadcrumbs, or null while they load or when the
 *        read failed: the card then says nothing rather than guess.
 */
@OptIn(ExperimentalTime::class)
internal fun gpsLineFor(trackingHere: Boolean, crumbs: List<Breadcrumb>?, zone: TimeZone): GpsLine? {
    if (trackingHere) return GpsLine("GPS tracking · live route", live = true)
    if (crumbs == null) return null
    if (crumbs.isEmpty()) return GpsLine("No GPS pings yet", live = false)
    val last = crumbs.mapNotNull { parseBreadcrumbMillis(it.timestamp) }.maxOrNull()
        ?: return GpsLine("GPS route recorded", live = false)
    val at = Instant.fromEpochMilliseconds(last).toLocalDateTime(zone)
    val hhmm = "${at.hour.toString().padStart(2, '0')}:${at.minute.toString().padStart(2, '0')}"
    return GpsLine("GPS route · last ping $hhmm", live = false)
}
