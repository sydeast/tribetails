package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.KinCareSession
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * Gatekeeper widget model: one household and how many days it has gone since
 * its last COMPLETED visit. Mirror of the web HouseholdGap.
 */
data class HouseholdGap(val household: String, val daysSinceLastVisit: Int)

/**
 * Gatekeeper widget logic: per-household days since the last COMPLETED visit,
 * longest gap first. Parses the visit date off completedAt (else startTime); a
 * household with no parseable completed visit, or a future date, is dropped.
 * Port of the web householdVisitGaps helper. Pure; unit-tested.
 */
fun householdVisitGaps(
    sessions: List<KinCareSession>,
    todayIso: String,
    limit: Int = 5,
): List<HouseholdGap> {
    val today = parseIsoDate(todayIso) ?: return emptyList()
    return sessions
        .filter { it.status.uppercase() == "COMPLETED" }
        .groupBy { it.kinfolkId.ifBlank { it.kinfolkName } }
        .mapNotNull { (_, group) ->
            val name = group.firstOrNull { it.kinfolkName.isNotBlank() }?.kinfolkName
                ?: return@mapNotNull null
            val lastDate = group
                .mapNotNull { s -> parseIsoDate((s.completedAt.orEmpty().ifBlank { s.startTime }).take(10)) }
                .maxOrNull() ?: return@mapNotNull null
            val days = ChronoUnit.DAYS.between(lastDate, today).toInt()
            if (days < 0) null else HouseholdGap(name, days)
        }
        .sortedByDescending { it.daysSinceLastVisit }
        .take(limit)
}

private fun parseIsoDate(s: String): LocalDate? =
    runCatching { LocalDate.parse(s.take(10)) }.getOrNull()
