package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.KinCareVisit

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
