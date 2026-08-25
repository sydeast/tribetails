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
    /**
     * Time-block booking: the NAMED window this visit was asked for, or null
     * when it was asked for on the clock. Verified server-side against the
     * business's own blocks — `requestBooking` refuses a window that does not
     * exist, is not active, or does not contain the instant sent with it.
     */
    val timeBlockId: String? = null,
)

/**
 * Time-block booking (operator requirement 2026-08-24): "kinfolk book within
 * time blocks, not at a specific set time."
 *
 * One bookable window off `business_settings.timeBlocks`, as `getBookingPolicy`
 * serves it. [startTime] is inclusive and [endTime] exclusive, both `HH:MM` in
 * the BUSINESS's timezone — the same convention AuntieOS's own resolver uses to
 * label a session with its block.
 */
data class TimeBlock(
    val id: String,
    val label: String,
    val startTime: String,
    val endTime: String,
    val durationMinutes: Int,
)

/** How a household says WHEN. Wire values, as stored in `business_settings`. */
enum class BookingMode { SpecificTime, TimeBlock }

/**
 * What this business lets a household choose, from `getBookingPolicy`.
 *
 * NORMALIZED SERVER-SIDE, and `requestBooking` validates against the same
 * resolver, so the wizard can never be offered a mode the write path refuses.
 * Two states this therefore cannot arrive in: block booking allowed with an
 * empty [timeBlocks], and neither mode allowed.
 */
data class BookingPolicy(
    val allowTimeBlockBooking: Boolean,
    val allowSpecificTimeBooking: Boolean,
    val defaultBookingMode: BookingMode,
    val timeBlocks: List<TimeBlock>,
) {
    companion object {
        /**
         * The pre-time-block world: clock times, no windows. What the wizard
         * runs on while the read is in flight or after it failed, and the exact
         * shape `getBookingPolicy` itself falls back to when its own settings
         * read fails.
         */
        val CLOCK_ONLY = BookingPolicy(
            allowTimeBlockBooking = false,
            allowSpecificTimeBooking = true,
            defaultBookingMode = BookingMode.SpecificTime,
            timeBlocks = emptyList(),
        )
    }
}

/**
 * C1 / #544: one resolved closed date, from `getBusinessClosures`. [date] is
 * `YYYY-MM-DD`; [name] is what the operator called the closure ("Closed"
 * when they left it blank).
 */
data class BusinessClosure(
    val date: String,
    val name: String,
)
