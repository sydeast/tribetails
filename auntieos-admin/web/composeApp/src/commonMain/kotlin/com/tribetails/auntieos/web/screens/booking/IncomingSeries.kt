package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.KinCareVisit
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * Stage 3 / 16.5 (web): a group of incoming (requested) kinCares belonging to ONE
 * booking envelope (batchId). The admin approves/cancels the whole envelope via
 * manageBookingSeries (which flips every child + creates the linked sessions
 * server-side). A single-visit request is a series of one - the same path handles
 * N>=1. Mirrors the AuntieOS android IncomingSeries.
 */
data class BookingSeries(
    val batchId: String,
    val kinfolkId: String,
    val kinfolkName: String,
    val serviceType: String,
    val visits: List<KinCareVisit>,
) {
    val visitCount: Int get() = visits.size
    val isSeries: Boolean get() = visits.size > 1
}

/** What a request card says when the household record did not read. */
const val HOUSEHOLD_NOT_ON_FILE: String = "Household name not on file"

private fun householdSuffix(name: String, preposition: String): String =
    name.trim().takeIf { it.isNotEmpty() }?.let { " $preposition $it" }.orEmpty()

/** #1577: WHO is asking, the card's title. Matches the web and Android queues. */
fun BookingSeries.householdLabel(): String = kinfolkName.trim().ifEmpty { HOUSEHOLD_NOT_ON_FILE }

/** What the request covers: its visit count and service. */
fun BookingSeries.subject(): String = buildString {
    append(if (visitCount == 1) "1 visit" else "$visitCount visits")
    if (isSeries) append(" · recurring series")
    if (serviceType.isNotBlank()) append(" · $serviceType")
}

/** #1577: the confirm step for Approve, titled with the household. */
fun BookingSeries.approveConfirmTitle(): String = "Book this request${householdSuffix(kinfolkName, "for")}"

/** #1577: the confirm step for Cancel (turning the request down), titled with the household. */
fun BookingSeries.declineConfirmTitle(): String = "Turn down this request${householdSuffix(kinfolkName, "from")}"

/** #1577: the detail sheet's title. */
fun BookingSeries.detailTitle(): String = "New request${householdSuffix(kinfolkName, "from")}"

private val WEEKDAYS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * One line per visit in the request, on the business clock: "Wed, Jun 3 at
 * 9:00 AM". A start that is not an instant is shown as it came, and a blank
 * one says so rather than inventing a time.
 */
@OptIn(ExperimentalTime::class)
fun BookingSeries.visitLines(zone: TimeZone): List<String> = visits.map { v ->
    val raw = v.startTime.trim()
    if (raw.isEmpty()) return@map "Time not on file"
    val instant = runCatching { Instant.parse(raw) }.getOrNull() ?: return@map raw
    val t = instant.toLocalDateTime(zone)
    val hour12 = if (t.hour % 12 == 0) 12 else t.hour % 12
    val ampm = if (t.hour < 12) "AM" else "PM"
    val minute = t.minute.toString().padStart(2, '0')
    "${WEEKDAYS[t.dayOfWeek.ordinal]}, ${MONTHS[t.month.ordinal]} ${t.day} at $hour12:$minute $ampm"
}

/**
 * Groups incoming KinCareVisits into per-envelope series, earliest-visit first.
 * Pure; unit-tested. batchId/kinfolkId come from KinCareVisit.pathParts
 * (families/{kinfolkId}/bookings/{batchId}/...). The child docs carry no
 * kinfolkName, so [resolveName] fills it from the directory (by kinfolkId); falls
 * back to the raw name then blank.
 */
fun groupIncomingBySeries(
    incoming: List<KinCareVisit>,
    resolveName: (kinfolkId: String) -> String? = { null },
): List<BookingSeries> =
    incoming
        .mapNotNull { v ->
            val (fid, batchId, _) = v.pathParts
            if (fid.isBlank() || batchId.isBlank()) null else Triple(fid, batchId, v)
        }
        // Composite (kinfolkId, batchId) key: a batchId is only unique WITHIN a
        // kinfolk, so grouping by batchId alone could merge two kinfolk's visits
        // into one series and approve them under a single kinfolkId. Never that.
        .groupBy { it.first to it.second }
        .map { (key, rows) ->
            val (kinfolkId, batchId) = key
            val sorted = rows.map { it.third }.sortedBy { it.startTime }
            val head = sorted.first()
            BookingSeries(
                batchId = batchId,
                kinfolkId = kinfolkId,
                kinfolkName = head.kinfolkName.ifBlank { resolveName(kinfolkId).orEmpty() },
                serviceType = head.serviceType,
                visits = sorted,
            )
        }
        .sortedBy { it.visits.firstOrNull()?.startTime ?: "" }
