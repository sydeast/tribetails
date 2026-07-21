package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.repository.IncomingKinCare

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
}

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
            val sorted = visits.sortedBy { it.startTime }
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
        .sortedBy { it.visits.firstOrNull()?.startTime ?: "" }
