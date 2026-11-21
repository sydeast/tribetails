package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.Breadcrumb
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #2338 / #2386: the Arrived card's GPS line, and whether it carries the live dot.
 *
 * The mock's line is "GPS tracking · live route" with a pulsing dot, and the
 * operator ruled (#2386) that it reads that while an Auntie's phone is
 * tracking the visit. The console never tracks a visit itself
 * (`JvmGpsTracker`), so "tracking" is read from the visit's route:
 *   - a ping from the last [LIVE_PING_WINDOW_MS] (one a little ahead of this
 *     clock counts too): live. A tracking phone writes one about every five
 *     seconds while it moves five metres or more.
 *   - otherwise when the route last pinged, or that none has landed, with no
 *     dot. This is what a visit put back to Arrived by "Undo departed" shows
 *     once nothing is tracking it, and also what a phone that has sat still
 *     for longer than the window shows, because it writes no ping then.
 * The same words and window as admin web (`components/VisitTrackingIndicator.tsx`)
 * and Android (`domain/GpsLine.kt`).
 */
internal data class GpsLine(val text: String, val live: Boolean)

/**
 * #2386: a ping this recent means a phone is tracking the visit. Ten minutes:
 * a tracking phone writes no ping while it stays within 5 m, so an Auntie
 * sitting still with a Kin goes quiet for minutes at a time while she is still
 * tracking. The same window on every client.
 */
internal const val LIVE_PING_WINDOW_MS: Long = 10 * 60_000L

/** How often an Arrived card reads the clock again, so "live" ages out with no new ping. */
internal const val GPS_LINE_TICK_MS: Long = 15_000L

private val LIVE = GpsLine("GPS tracking · live route", live = true)

/**
 * PURE.
 *
 * @param crumbs the visit's breadcrumbs, or null while they load or when the
 *        read failed: the card then says nothing rather than guess.
 * @param nowMs this machine's clock, read again every [GPS_LINE_TICK_MS].
 */
@OptIn(ExperimentalTime::class)
internal fun gpsLineFor(trackingHere: Boolean, crumbs: List<Breadcrumb>?, zone: TimeZone, nowMs: Long): GpsLine? {
    if (trackingHere) return LIVE
    if (crumbs == null) return null
    if (crumbs.isEmpty()) return GpsLine("No GPS pings yet", live = false)
    val last = crumbs.mapNotNull { parseBreadcrumbMillis(it.timestamp) }.maxOrNull()
        ?: return GpsLine("GPS route recorded", live = false)
    if (nowMs - last <= LIVE_PING_WINDOW_MS) return LIVE
    val at = Instant.fromEpochMilliseconds(last).toLocalDateTime(zone)
    val hhmm = "${at.hour.toString().padStart(2, '0')}:${at.minute.toString().padStart(2, '0')}"
    return GpsLine("GPS route · last ping $hhmm", live = false)
}
