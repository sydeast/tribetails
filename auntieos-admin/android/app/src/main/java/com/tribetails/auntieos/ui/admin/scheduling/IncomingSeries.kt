package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.model.resolveBusinessTimeZone
import com.tribetails.auntieos.data.repository.IncomingKinCare
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Stage 3 / 16.5: a group of incoming (requested) kinCares that belong to ONE
 * booking envelope (batchId). The admin approves/cancels the WHOLE envelope via
 * manageBookingSeries (which flips every child + creates the linked sessions
 * server-side). A single-visit request is just a series of one - the same
 * approve/cancel path handles N>=1 uniformly.
 */
data class IncomingSeries(
    val batchId: String,
    val kinfolkId: String,
    val familyId: String,
    val kinfolkName: String,
    val serviceType: String,
    val visits: List<IncomingKinCare>,
) {
    val visitCount: Int get() = visits.size
    val isSeries: Boolean get() = visits.size > 1

    /**
     * #1098: the visits asked for as a NIGHT (an Overnight), each waiting for
     * the operator to set its start time before the request can be approved.
     */
    val pendingNights: List<IncomingKinCare> get() = visits.filter { it.startTimePending }
}

/**
 * The key one night's chosen start time is held under. A visit id is unique
 * only inside its household and request, so the key carries both.
 */
fun seriesNightKey(series: IncomingSeries, visitId: String): String =
    "${series.familyId}/${series.batchId}/$visitId"

/** Whether every night in [series] has a start time in [picks]. A series with no night is always ready. */
fun seriesReadyToApprove(series: IncomingSeries, picks: Map<String, LocalTime>): Boolean =
    series.pendingNights.all { picks[seriesNightKey(series, it.visitId)] != null }

/**
 * The `startTimes` payload for approving [series]: each night's chosen wall
 * clock on its own requested date, read in [zone], as epoch ms by visit id.
 * Null when a night has no time yet or no readable date.
 */
fun seriesStartTimesMs(
    series: IncomingSeries,
    picks: Map<String, LocalTime>,
    zone: ZoneId,
): Map<String, Long>? {
    val out = LinkedHashMap<String, Long>()
    for (night in series.pendingNights) {
        val time = picks[seriesNightKey(series, night.visitId)] ?: return null
        val date = runCatching { LocalDate.parse(night.requestedDate) }.getOrNull() ?: return null
        out[night.visitId] = date.atTime(time).atZone(zone).toInstant().toEpochMilli()
    }
    return out
}

/**
 * The zone a night's start time is read in: `business_settings.timeZone`,
 * because that is the zone the server derived the night in and checks the
 * time against. A blank or unknown zone resolves to the server's own default,
 * America/Chicago (#1109), never to the device's zone.
 */
fun businessZoneOf(timeZone: String): ZoneId = ZoneId.of(resolveBusinessTimeZone(timeZone))

private val NIGHT_FORMAT = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)

/** `2026-10-09` -> "Fri, Oct 9". A value that is not a date is shown as it came. */
fun nightLabel(requestedDate: String): String =
    runCatching { LocalDate.parse(requestedDate).format(NIGHT_FORMAT) }.getOrDefault(requestedDate)

/**
 * Groups the flat incoming-requested queue into per-envelope series, newest
 * (earliest upcoming visit) first. Pure; unit-tested. The manageBookingSeries
 * path key is the families/{kinfolkId} doc, so prefer kinfolkId and fall back to
 * familyId (they are the same doc id in practice).
 *
 * The child kinCare docs carry no kinfolkName, so [resolveName] lets the caller
 * fill it from the loaded directory (by kinfolkId); falls back to the raw name
 * then blank.
 */
fun groupIncomingBySeries(
    incoming: List<IncomingKinCare>,
    resolveName: (kinfolkId: String) -> String? = { null },
): List<IncomingSeries> =
    incoming
        .filter { it.batchId.isNotBlank() && it.familyId.isNotBlank() }
        // Composite (familyId, batchId) key: a batchId is only unique WITHIN a
        // kinfolk, so grouping by batchId alone could merge two kinfolk's visits
        // into one series and approve them under a single id. familyId is the
        // families/{id} doc path parent, i.e. the exact id the backend keys the
        // envelope on (families/{id}/bookings/{batchId}) and what AuntieOS web
        // sends, so we use it (not the doc's kinfolkId field) for byte parity.
        .groupBy { it.familyId to it.batchId }
        .map { (key, visits) ->
            val (kinfolkId, batchId) = key
            // A night awaiting its start time (#1098) has a blank startTime, so
            // it sorts by its requested date instead of jumping to the front.
            val sorted = visits.sortedBy { it.startTime.ifBlank { it.requestedDate } }
            val head = sorted.first()
            IncomingSeries(
                batchId = batchId,
                kinfolkId = kinfolkId,
                familyId = head.familyId,
                kinfolkName = head.kinfolkName.ifBlank { resolveName(kinfolkId).orEmpty() },
                serviceType = head.serviceType,
                visits = sorted,
            )
        }
        .sortedBy { series -> series.visits.firstOrNull()?.let { it.startTime.ifBlank { it.requestedDate } } ?: "" }
