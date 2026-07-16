package com.tribetails.auntieos.data.model

import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.GeoPoint

/**
 * Finalised GPS summary baked onto `kin_care_sessions/{sid}` when DEPARTED
 * fires. Mirrors the AuntieOS web shape so MyTribe + the future Departed-email
 * flow can render replay without re-reading the breadcrumb subcollection.
 * Down-sampled to ≤1000 points so the doc stays well under Firestore's 1MB
 * limit even for multi-hour overnights.
 */
data class GpsSummary(
    var distanceMeters: Double = 0.0,
    var durationSeconds: Long = 0L,
    var startLat: Double = 0.0,
    var startLng: Double = 0.0,
    var endLat: Double = 0.0,
    var endLng: Double = 0.0,
    var route: List<GpsPoint> = emptyList(),
    var computedAt: String = "",
)

data class GpsPoint(
    var lat: Double = 0.0,
    var lng: Double = 0.0,
    /** Epoch millis. 0 if unknown. */
    var t: Long = 0L,
)

// Location tracking models for kin care visits
data class LocationPoint(
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    val altitude: Double = 0.0,
    val accuracy: Float = 0.0f,
    val timestamp: Long = System.currentTimeMillis(),
    val speed: Float = 0.0f, // m/s
    val bearing: Float = 0.0f // degrees
) {
    fun toGeoPoint(): GeoPoint = GeoPoint(latitude, longitude)

    fun distanceTo(other: LocationPoint): Double {
        val earthRadius = 6371000.0 // meters
        val dLat = Math.toRadians(other.latitude - latitude)
        val dLon = Math.toRadians(other.longitude - longitude)
        val lat1 = Math.toRadians(latitude)
        val lat2 = Math.toRadians(other.latitude)

        val a = kotlin.math.sin(dLat / 2) * kotlin.math.sin(dLat / 2) +
                kotlin.math.sin(dLon / 2) * kotlin.math.sin(dLon / 2) * kotlin.math.cos(lat1) * kotlin.math.cos(lat2)
        val c = 2 * kotlin.math.atan2(kotlin.math.sqrt(a), kotlin.math.sqrt(1 - a))

        return earthRadius * c
    }
}

data class VisitRoute(
    @DocumentId val id: String = "",
    var kinCareSessionId: String = "",
    var kinfolkId: String = "",
    var kinIds: List<String> = emptyList(),
    var startTime: String = "",
    var endTime: String = "",
    var totalDistance: Double = 0.0, // meters
    var totalDuration: Long = 0L, // milliseconds
    var averageSpeed: Double = 0.0, // m/s
    var maxSpeed: Double = 0.0, // m/s
    var visitVerified: Boolean = false,
    var arrivalTime: String = "",
    var departureTime: String = "",
    var homeLocation: LocationPoint? = null,
    var notes: String = "",
    var createdAt: String = "",
    var updatedAt: String = ""
)

data class LocationCheckpoint(
    @DocumentId val id: String = "",
    var routeId: String = "",
    var location: LocationPoint = LocationPoint(),
    var checkpointType: CheckpointType = CheckpointType.WAYPOINT,
    var description: String = "",
    var photoUrl: String = "",
    var timestamp: String = "",
    var notes: String = ""
)

enum class CheckpointType {
    START,      // Visit start location
    ARRIVAL,    // Arrived at client's home
    WAYPOINT,   // Point during walk/visit
    PHOTO_STOP, // Location where photo was taken
    DEPARTURE,  // Left client's home
    END         // Visit end location
}

data class VisitLocationSummary(
    val visitDuration: Long = 0L, // milliseconds at client location
    val walkDistance: Double = 0.0, // meters walked with pets
    val walkDuration: Long = 0L, // milliseconds walking
    val averageWalkingSpeed: Double = 0.0, // m/s
    val homeArrivalVerified: Boolean = false,
    val homeDepartureVerified: Boolean = false,
    val visitedLocations: List<String> = emptyList(), // Notable locations visited
    val photoLocations: Int = 0 // Number of photos taken during visit
)

// Enhanced KinCareSession with location tracking
data class KinCareSessionWithLocation(
    @DocumentId val id: String = "",
    var kinId: String = "",
    var kinfolkId: String = "",
    var startTime: String = "",
    var endTime: String = "",
    var serviceType: String = "",
    var notes: String = "",
    var status: String = "scheduled", // scheduled, active, completed, cancelled
    var routeId: String = "", // Reference to VisitRoute
    var locationSummary: VisitLocationSummary = VisitLocationSummary(),
    // Removed: isLocationTrackingEnabled (now controlled by BusinessSettings)
    var createdAt: String = "",
    var updatedAt: String = ""
)

// Business/Operational settings - only service provider can control.
//
// UNIFIED settings model (2026-06-05 unification, see
// docs/2026-06-05-settings-unification-design.md). This is the ONE canonical
// settings doc `business_settings/business_settings`. It absorbs the former
// `admin_settings/admin_settings` doc (booking config + timeBlocks + business
// profile) so web + android share a single union. Field names below are the
// Firestore wire names. Saves go through AuntieRepository.saveBusinessSettings
// with SetOptions.merge() read-modify-write so no sibling field is ever
// clobbered.
data class BusinessSettings(
    @DocumentId val id: String = "business_settings", // Single document
    // --- Business profile (migrated from admin_settings) ---
    var businessName: String = "",
    var businessEmail: String = "",
    var businessPhone: String = "",
    var businessAddress: String = "",
    var timeZone: String = "America/New_York",
    var serviceRates: Map<String, String> = emptyMap(),
    var businessHours: Map<String, String> = emptyMap(), // day -> "HH:MM-HH:MM" or ""
    // --- GPS / tracking ---
    var enableGPSTrackingForAllVisits: Boolean = true, // Master GPS tracking switch
    var enablePhotoLocationTagging: Boolean = true,
    var requireArrivalDepartureVerification: Boolean = true,
    var autoStartTrackingOnVisitStart: Boolean = true,
    var trackingAccuracy: TrackingAccuracy = TrackingAccuracy.HIGH,
    var saveRoutesForDays: Int = 90, // Legal/liability retention
    var allowClientLocationSharing: Boolean = true, // Whether clients can see any location data
    // "On My Way" defaults - surfaced as a dropdown on the visit card
    var defaultEtaMinutes: Int = 15,
    var etaMinuteOptions: List<Int> = listOf(5, 10, 15, 20, 30, 45, 60),
    // KinTale draft retention - auto-purge unsent drafts older than this
    var draftRetentionDays: Int = 30,
    var draftRetentionOptions: List<Int> = listOf(30, 60, 90),
    // Time Off - observed US federal holidays + custom company holidays.
    // observedUsHolidays: list of US_HOLIDAY ids (see UsHolidays). companyHolidays:
    // freeform "YYYY-MM-DD|Name" entries.
    var observedUsHolidays: List<String> = emptyList(),
    var companyHolidays: List<String> = emptyList(),
    // specialHours (15.5): modified operating hours for a specific date (short day,
    // late open), freeform "YYYY-MM-DD|hours". Distinct from a full closure above.
    // Parity with web BusinessSettings.specialHours.
    var specialHours: List<String> = emptyList(),
    // observeUsHolidays: android scheduling toggle (distinct from the
    // observedUsHolidays list above). Migrated from admin_settings.
    var observeUsHolidays: Boolean = false,
    // --- Booking / scheduling config (migrated from admin_settings) ---
    // defaultBookingMode is a wire String ("SPECIFIC_TIME"|"TIME_BLOCK") matching
    // the BookingMode enum names; use [defaultBookingModeEnum] for the typed value.
    var defaultBookingMode: String = "SPECIFIC_TIME",
    var defaultCalendarView: String = "MONTH",
    var allowTimeBlockBooking: Boolean = true,
    var allowSpecificTimeBooking: Boolean = true,
    var enableConflictDetection: Boolean = true,
    var enableAutoReminder24h: Boolean = false,
    var defaultTimeBlockDurationHours: Int = 4, // Default 4-hour blocks
    var travelBufferMinutes: Int = 30,
    // timeBlocks: booking time-block definitions. Element key `active` matches prod
    // (Firestore strips the `is` prefix so TimeBlockDefinition.isActive -> "active").
    var timeBlocks: List<TimeBlockDefinition> = listOf(
        TimeBlockDefinition(id = "midday", label = "Midday", startTime = "11:00", endTime = "15:00", isActive = true)
    ),
    // Google Calendar sync id (front-facing setup). The admin enters the shared
    // calendar id here; the syncGoogleCalendarBusyEvents Cloud Function reads this
    // doc field first and only falls back to the GOOGLE_CALENDAR_ID secret when it
    // is empty. Auth stays a pinned service account the admin shares the calendar
    // with (no OAuth, no token storage). Parity with web BusinessSettings.calendarSyncId.
    var calendarSyncId: String = "",
    // --- Booking behavior (#9, 2026-06-08) ---
    // Real persisted toggles (admin-writable; no callable). Parity with web.
    // autoConfirmRepeatKinfolk is consumed server-side by requestBooking (a repeat
    // kinfolk's request is confirmed immediately). snapRescheduleTo15Min snaps the
    // schedule drag to quarter-hours. Both default false (behavior unchanged).
    var autoConfirmRepeatKinfolk: Boolean = false,
    var snapRescheduleTo15Min: Boolean = false,
    // --- Branding (17.2) ---
    // Operator-editable brand identity, persisted on this same business_settings doc
    // via the existing merge write (rule: write if isAuntie()); no backend. Each is
    // blank-safe: an empty value keeps the shipped default so the app reads identical
    // until customized. Wire names match web BusinessSettings byte-for-byte. Resolved
    // for display by the pure helpers in ui/branding/Branding.kt.
    var logoUrl: String = "",        // nav/home brand mark image (Cloudinary URL); blank -> PawPrint glyph
    var brandWordmark: String = "",  // app name; blank -> "AuntieOS"
    var brandTagline: String = "",   // tagline; blank -> "Tribe Tails Care"
    var homeGreeting: String = "",   // Home heading salutation; blank -> time-aware greetingForHour()
    var homeAccentTail: String = "", // Home heading accent word; blank -> "Auntie."
    // --- Payment handles (A8 Payments) ---
    // Operator-entered handles for the peer-to-peer apps clients pay through; rendered
    // in the invoice "How to pay" section and on the invoice PDF. Blank -> that method
    // is omitted. Same merge write (write if isAuntie()), no backend. Parity with web.
    var venmoHandle: String = "",
    var paypalHandle: String = "",
    var cashappHandle: String = "",
    // --- Weather area (W16/W17) ---
    // Service-AREA place name (city / metro / ZIP) the Home weather widgets forecast for.
    // NOT the street address — operator picks coverage area (e.g. "Austin, TX"). Blank ->
    // widgets show a fail-loud "set your weather area" prompt. Parity with web.
    var weatherLocation: String = "",
    var updatedAt: String = "",
    var updatedBy: String = "" // Admin user who made the change
) {
    /** Typed view of the [defaultBookingMode] wire string. Unknown strings fall back to SPECIFIC_TIME. */
    val defaultBookingModeEnum: BookingMode
        get() = runCatching { BookingMode.valueOf(defaultBookingMode) }.getOrDefault(BookingMode.SPECIFIC_TIME)
}

/** Copy [BusinessSettings] setting [defaultBookingMode] from a typed [BookingMode]. */
fun BusinessSettings.withBookingMode(mode: BookingMode): BusinessSettings =
    this.copy(defaultBookingMode = mode.name)

enum class TrackingAccuracy {
    LOW,    // Battery-friendly, less precise
    MEDIUM, // Balanced
    HIGH    // Most precise for liability protection
}

// Location sharing preferences for kinfolk - VIEWING ONLY, not tracking control
data class LocationSharingPreferences(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    // Removed: enableRouteTracking, enableLiveTracking (now business decisions)
    var shareDetailedRoute: Boolean = true,
    var sharePhotoLocations: Boolean = true,
    var shareArrivalDepartureTimes: Boolean = true,
    var notifyOnArrival: Boolean = true,
    var notifyOnDeparture: Boolean = true,
    var updatedAt: String = ""
)

