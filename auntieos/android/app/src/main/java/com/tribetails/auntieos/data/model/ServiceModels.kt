package com.tribetails.auntieos.data.model

import androidx.annotation.Keep

import com.google.firebase.firestore.DocumentId

// === SERVICE MANAGEMENT MODELS ===

@Keep
data class BaseService(
    @DocumentId val id: String = "",
    var title: String = "",
    var description: String = "",
    var durationMinutes: Int = 60, // Default 1 hour
    var basePrice: Double = 0.0,
    var isActive: Boolean = true,
    var category: String = "", // e.g., "Dog Walking", "Pet Sitting", "Overnight Care"
    var tags: List<String> = emptyList(),
    var requiresSpecialEquipment: Boolean = false,
    var equipmentNotes: String = "",
    var createdAt: String = "",
    var updatedAt: String = "",
    var businessRules: ServiceBusinessRules = ServiceBusinessRules()
) {
    val displayDuration: String get() = "${durationMinutes / 60}h ${durationMinutes % 60}m".replace(" 0m", "")
}

@Keep
data class ServiceBusinessRules(
    var allowWeekends: Boolean = true,
    var allowHolidays: Boolean = false,
    var minimumLeadTimeHours: Int = 24,
    var maximumAdvanceBookingDays: Int = 365,
    var allowBackToBackBookings: Boolean = true,
    var requiresApproval: Boolean = false
)

@Keep
data class SupplementalService(
    @DocumentId val id: String = "",
    var title: String = "",
    var description: String = "",
    var price: Double = 0.0,
    var isActive: Boolean = true,
    var canAttachToServices: List<String> = emptyList(), // Base service IDs this can attach to
    var isStandaloneService: Boolean = false, // Can be booked independently
    var category: String = "", // e.g., "Add-on", "Upgrade", "Special Care"
    var createdAt: String = "",
    var updatedAt: String = ""
)

// === PRICING & PROMOTIONS MODELS ===

@Keep
data class Surcharge(
    @DocumentId val id: String = "",
    var title: String = "",
    var description: String = "",
    var type: SurchargeType = SurchargeType.FIXED_AMOUNT,
    var amount: Double = 0.0, // Fixed amount or percentage
    var isActive: Boolean = true,
    var applicableConditions: SurchargeConditions = SurchargeConditions(),
    var createdAt: String = "",
    var updatedAt: String = ""
)

enum class SurchargeType {
    FIXED_AMOUNT, PERCENTAGE_OF_TOTAL, PERCENTAGE_OF_SERVICE
}

@Keep
data class SurchargeConditions(
    var applyOnWeekends: Boolean = false,
    var applyOnHolidays: Boolean = false,
    var applyAfterHours: Boolean = false, // Outside business hours
    var afterHoursStart: String = "18:00", // 6 PM
    var afterHoursEnd: String = "08:00", // 8 AM
    var minimumServiceValue: Double = 0.0,
    var applicableServiceIds: List<String> = emptyList(),
    var applicableDayOfWeek: List<Int> = emptyList() // 1=Monday, 7=Sunday
)

@Keep
data class Discount(
    @DocumentId val id: String = "",
    var title: String = "",
    var description: String = "",
    var type: DiscountType = DiscountType.PERCENTAGE,
    var amount: Double = 0.0, // Percentage (0-100) or fixed amount
    var isActive: Boolean = true,
    var conditions: DiscountConditions = DiscountConditions(),
    var createdAt: String = "",
    var updatedAt: String = ""
)

enum class DiscountType {
    PERCENTAGE, FIXED_AMOUNT
}

@Keep
data class DiscountConditions(
    var minimumPurchase: Double = 0.0,
    var applicableServiceIds: List<String> = emptyList(), // Empty = applies to all
    var validFrom: String = "",
    var validUntil: String = "",
    var maxUsagePerCustomer: Int = -1, // -1 = unlimited
    var requiresNewCustomer: Boolean = false,
    var buyXGetYConfig: BuyXGetYConfig? = null
)

@Keep
data class BuyXGetYConfig(
    var buyQuantity: Int = 1,
    var getQuantity: Int = 1,
    var getDiscountPercentage: Double = 100.0 // 100% = free, 50% = half price
)

@Keep
data class PromoCode(
    @DocumentId val id: String = "",
    var code: String = "",
    var title: String = "",
    var description: String = "",
    var discountType: DiscountType = DiscountType.PERCENTAGE,
    var discountAmount: Double = 0.0,
    var isActive: Boolean = true,
    var usageLimit: Int = -1, // -1 = unlimited
    var usedCount: Int = 0,
    var validFrom: String = "",
    var validUntil: String = "",
    var applicableServiceIds: List<String> = emptyList(),
    var minimumPurchase: Double = 0.0,
    var createdAt: String = "",
    var updatedAt: String = ""
)

// === ENHANCED BOOKING & SCHEDULING MODELS ===

@Keep
data class BookingTimeSlot(
    @DocumentId val id: String = "",
    var date: String = "", // YYYY-MM-DD format
    var startTime: String = "", // HH:mm format
    var endTime: String = "", // HH:mm format
    var isAvailable: Boolean = true,
    var slotType: TimeSlotType = TimeSlotType.AVAILABLE,
    var notes: String = "",
    var createdAt: String = "",
    var source: TimeSlotSource = TimeSlotSource.INTERNAL_MANUAL,
    var externalEventId: String? = null,
    var externalCalendarId: String? = null,
    var hideDetailsFromKinfolk: Boolean = true,
    var isEditableByAdmin: Boolean = true,
    var isRemovableByAdmin: Boolean = true,
    var syncState: TimeSlotSyncState = TimeSlotSyncState.LOCAL_ONLY
)

enum class TimeSlotType {
    AVAILABLE, BLOCKED, HOLIDAY, PERSONAL_TIME, MAINTENANCE
}

enum class TimeSlotSource {
    INTERNAL_MANUAL,
    GOOGLE_BUSY_IMPORT,
    SYSTEM_RULE
}

enum class TimeSlotSyncState {
    LOCAL_ONLY,
    SYNCED,
    OVERRIDDEN,
    DISMISSED,
    FAILED
}

@Keep
data class TimeBlockDefinition(
    var id: String = "midday",
    var label: String = "Midday",
    var startTime: String = "11:00",
    var endTime: String = "15:00",
    var isActive: Boolean = true
)

@Keep
data class BusinessHours(
    @DocumentId val id: String = "",
    var dayOfWeek: Int = 1, // 1=Monday, 7=Sunday
    var isOpen: Boolean = true,
    var openTime: String = "09:00",
    var closeTime: String = "17:00",
    var breakStart: String? = null, // Optional lunch break
    var breakEnd: String? = null,
    var notes: String = ""
)

enum class BookingMode {
    SPECIFIC_TIME, // Client can request exact time like 11:15 AM
    TIME_BLOCK    // Client chooses within a time block like 11 AM - 3 PM
}

enum class BookingStatus {
    DRAFT, ACCEPTED, REJECTED, COMPLETED
}

// AdminSettings removed 2026-06-05 (settings unification). All of its fields
// (booking config, timeBlocks, business profile, timeZone) now live on the
// unified BusinessSettings model (data/model/LocationModels.kt) backed by the
// single business_settings/business_settings doc. See
// docs/2026-06-05-settings-unification-design.md.

// === ENHANCED EVENT MODEL ===

@Keep
data class EnhancedBooking(
    @DocumentId val id: String = "",
    var title: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var kinIds: List<String> = emptyList(), // Multiple pets can be in one booking
    var kinNames: List<String> = emptyList(),

    // Service Details
    var baseServiceId: String = "",
    var baseServiceTitle: String = "",
    var supplementalServices: List<BookedSupplementalService> = emptyList(),

    // Timing
    var startDateTime: String = "", // ISO 8601 format
    var endDateTime: String = "",
    var bookingMode: BookingMode = BookingMode.SPECIFIC_TIME,
    var timeBlockStart: String? = null, // Only if booking mode is TIME_BLOCK
    var timeBlockEnd: String? = null,

    // Pricing
    var basePrice: Double = 0.0,
    var surcharges: List<AppliedSurcharge> = emptyList(),
    var discounts: List<AppliedDiscount> = emptyList(),
    var promoCodeUsed: String? = null,
    var totalPrice: Double = 0.0,

    // Status & Workflow
    var status: BookingStatus = BookingStatus.DRAFT,
    var requiresApproval: Boolean = false,
    var approvedBy: String? = null,
    var approvedAt: String? = null,

    // Additional Information
    var notes: String = "",
    var specialInstructions: String = "",
    var internalNotes: String = "",
    var requestedArrivalTime: String? = null,
    var waitlistOptIn: Boolean = false,
    var transportationAddonSelected: Boolean = false,
    var pickupDropoffRequested: Boolean = false,
    var cancellationReason: String? = null,
    var cancellationDate: String? = null,

    // Tracking
    var createdAt: String = "",
    var updatedAt: String = "",
    var createdBy: String = "", // Admin user ID
    var lastModifiedBy: String = "",

    // Google Calendar Integration
    var googleCalendarEventId: String? = null,
    var lastSyncedAt: String? = null,
    var syncStatus: CalendarSyncStatus = CalendarSyncStatus.NOT_SYNCED,

    // Archive metadata. Set when archive flips status; cleared on unarchive.
    // Mirrors Kinfolk archive pattern (Phase 2): reversible state flip, document
    // remains in Firestore, filtered out of active queries.
    var archivedAt: String = "",
    var archivedReason: String = "",
    var archivedBy: String = "",

    // Phase 14: answers to admin-authored form_schemas placed on BOOKING
    // (appliesTo == "BOOKING"), keyed by field id. Android bookings persist as
    // EnhancedBooking docs (web uses KinCareSession); each platform carries its own.
    var formValues: Map<String, String> = emptyMap(),
) {
    val isArchived: Boolean get() = archivedAt.isNotBlank()
}

@Keep
data class BookedSupplementalService(
    val serviceId: String,
    val title: String,
    val price: Double
)

@Keep
data class AppliedSurcharge(
    val surchargeId: String,
    val title: String,
    val amount: Double,
    val type: SurchargeType
)

@Keep
data class AppliedDiscount(
    val discountId: String?,
    val title: String,
    val amount: Double,
    val type: DiscountType
)

enum class CalendarSyncStatus {
    NOT_SYNCED, SYNCED, SYNC_PENDING, SYNC_FAILED, CONFLICT_DETECTED
}

enum class UnavailabilityReasonType {
    CONFLICTING_BOOKING,
    BLOCKED_SLOT,
    OUTSIDE_WORKING_HOURS,
    TIME_BLOCK_FULLY_BOOKED,
    TRAVEL_BUFFER,
    UNKNOWN
}

@Keep
data class AvailabilityOption(
    val startDateTime: String,
    val endDateTime: String,
    val reason: String
)

@Keep
data class BookingAvailabilityRequest(
    val startDateTime: String,
    val endDateTime: String,
    val excludeBookingId: String? = null,
    val travelBufferMinutes: Int = 30,
    val timeBlocks: List<TimeBlockDefinition> = emptyList(),
    val treatDraftAsUnavailable: Boolean = true
)

@Keep
data class BookingAvailabilityResult(
    val isAvailable: Boolean,
    val reason: UnavailabilityReasonType? = null,
    val message: String? = null,
    val conflictingBookings: List<EnhancedBooking> = emptyList(),
    val conflictingBlocks: List<BookingTimeSlot> = emptyList(),
    val suggestedOptions: List<AvailabilityOption> = emptyList(),
    val showWaitlist: Boolean = false
)

@Keep
data class ExternalBusyCalendarEvent(
    val externalEventId: String,
    val calendarId: String,
    val startDateTime: String,
    val endDateTime: String,
    val isBusy: Boolean = true,
    val isAppManaged: Boolean = false
)

