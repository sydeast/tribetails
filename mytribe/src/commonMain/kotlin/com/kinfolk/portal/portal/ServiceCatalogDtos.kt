package com.kinfolk.portal.portal

data class Service(
    val id: String,
    val name: String,
    val category: String?,
    val description: String?,
    /** Single price (cents) — when set, price is fixed. */
    val priceCents: Long?,
    /** Range minimum (cents) — when set, price is variable. */
    val priceMinCents: Long?,
    /** Range maximum (cents) — when set, price is variable. */
    val priceMaxCents: Long?,
    val isOvernight: Boolean,
    val iconKey: String?,
)

data class ServiceCatalog(
    val services: List<Service>,
)

/**
 * Shared vet clinic catalog, mirrored from AuntieOS admin-side `vet_clinics`
 * collection. Surfaced on MyTribe so a kinfolk can see (and pick) the clinic
 * already set on their household — and add new ones via TribeScreen
 * customFields when appropriate.
 */
data class VetClinic(
    val id: String,
    val name: String,
    val phone: String,
    val address: String,
    val website: String = "",
    val googleMapsUrl: String = "",
    val isEmergency: Boolean = false,
)

enum class BookingPattern { Individual, Weekly }

data class BookingVisit(
    val startTimeMs: Long,
    val endTimeMs: Long?,
    val serviceId: String,
    val serviceName: String,
    val priceCents: Long?,
)
