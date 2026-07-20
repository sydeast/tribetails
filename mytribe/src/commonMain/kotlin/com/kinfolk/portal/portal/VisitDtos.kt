package com.kinfolk.portal.portal

import com.kinfolk.portal.components.RoutePoint

/**
 * Past kin care session surfaced to the kinfolk for replay. Includes optional
 * GPS summary written by AuntieOS at DEPARTED time.
 */
data class Visit(
    val id: String,
    val status: String,
    val serviceType: String?,
    val startTimeIso: String?,
    val endTimeIso: String?,
    val arrivedAtIso: String?,
    val departedAtIso: String?,
    val gpsRoute: List<RoutePoint> = emptyList(),
    val gpsDistanceMeters: Double? = null,
    val gpsDurationSeconds: Long? = null,
)

data class VisitsResult(val visits: List<Visit>)
