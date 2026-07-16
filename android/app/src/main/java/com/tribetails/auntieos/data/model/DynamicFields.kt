package com.tribetails.auntieos.data.model

import com.google.firebase.firestore.DocumentId
import com.google.gson.annotations.SerializedName

// Dynamic Field Definition - defines the structure of custom fields
data class FieldDefinition(
    @DocumentId val id: String = "",
    var fieldName: String = "",
    var displayLabel: String = "",
    var fieldType: FieldType = FieldType.TEXT,
    var isRequired: Boolean = false,
    var section: String = "CUSTOM", // Which section this field appears in
    var targetEntity: TargetEntity = TargetEntity.KINFOLK, // Kinfolk or Kin
    var options: List<String> = emptyList(), // For dropdown/radio fields
    var validationRules: ValidationRules = ValidationRules(),
    var defaultValue: String = "",
    var helpText: String = "",
    var sortOrder: Int = 0,
    var isActive: Boolean = true,
    var createdAt: String = "",
    var updatedAt: String = ""
)

enum class FieldType {
    TEXT,           // Single line text
    TEXTAREA,       // Multi-line text
    NUMBER,         // Numeric input
    DECIMAL,        // Decimal numbers
    BOOLEAN,        // True/false checkbox
    DATE,           // Date picker
    TIME,           // Time picker
    DATETIME,       // Date and time
    DROPDOWN,       // Single selection dropdown
    RADIO,          // Radio buttons
    CHECKBOX_LIST,  // Multiple selection checkboxes
    EMAIL,          // Email with validation
    PHONE,          // Phone number with validation
    URL,            // URL with validation
    CURRENCY,       // Money amount
    RATING,         // 1-5 star rating
    FILE_UPLOAD,    // File/image upload
    COLOR,          // Color picker
    LOCATION        // Address/GPS location
}

enum class TargetEntity {
    KINFOLK,        // Field applies to Kinfolk profiles
    KIN,            // Field applies to Kin profiles
    HOUSEHOLD       // Field applies to household data
}

data class ValidationRules(
    var minLength: Int? = null,
    var maxLength: Int? = null,
    var minValue: Double? = null,
    var maxValue: Double? = null,
    var regex: String? = null,
    var customErrorMessage: String? = null
)

// Dynamic Field Value - stores the actual field data
data class DynamicFieldValue(
    @DocumentId val id: String = "",
    var entityId: String = "", // ID of the Kinfolk/Kin this value belongs to
    var entityType: TargetEntity = TargetEntity.KINFOLK,
    var fieldDefinitionId: String = "",
    var fieldName: String = "", // Cache for performance
    var value: String = "", // All values stored as strings, converted based on type
    var createdAt: String = "",
    var updatedAt: String = ""
)

// Household Data - shared data for all animals in a household
data class HouseholdData(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",

    // Veterinary Information (shared by all pets)
    var primaryVetName: String = "",
    var primaryVetPhone: String = "",
    var primaryVetAddress: String = "",
    var primaryVetHours: String = "",
    var emergencyVetName: String = "",
    var emergencyVetPhone: String = "",
    var emergencyVetAddress: String = "",

    // Household Items & Locations
    var foodLocation: String = "",
    var treatLocation: String = "",
    var medicationLocation: String = "",
    var toysLocation: String = "",
    var beddingLocation: String = "",
    var leashesPoopBagsLocation: String = "",
    var cleaningSuppliesLocation: String = "",

    // Household Routines & Preferences
    var householdRules: String = "",
    var preferredWalkRoutes: String = "",
    var neighborhoodHazards: String = "",
    var securitySystemInfo: String = "",
    var thermostatInstructions: String = "",
    var lightingPreferences: String = "",

    // Emergency & Safety
    var poisonControlNumber: String = "",
    var emergencyContactsPriority: String = "",
    var evacuationPlan: String = "",
    var importantDocumentsLocation: String = "",

    // Service Provider Information
    var groomerName: String = "",
    var groomerPhone: String = "",
    var trainerName: String = "",
    var trainerPhone: String = "",
    var petSitterBackup: String = "",
    var dogWalkerBackup: String = "",

    var createdAt: String = "",
    var updatedAt: String = ""
)

// Media Storage Models
data class MediaFile(
    @DocumentId val id: String = "",
    var entityId: String = "", // ID of Kinfolk/Kin/Household this media belongs to
    var entityType: MediaEntityType = MediaEntityType.KIN,
    var kinfolkId: String = "",                 // Stage 0I sandbox scope: == testTribeId on test-admin writes so the rules (testOwnsIncoming/Existing) allow them; blank for the operator (media stays keyed by entityId/entityType).
    var fileName: String = "",
    var originalFileName: String = "",
    var fileType: MediaType = MediaType.IMAGE,
    var mimeType: String = "",
    var fileSizeBytes: Long = 0,
    var storageUrl: String = "", // URL to the stored file
    var thumbnailUrl: String = "", // Smaller version for previews
    var uploadedAt: String = "",
    var uploadedBy: String = "", // User who uploaded
    var tags: List<String> = emptyList(),
    // #13 Gallery: kin tagged IN this image (a list of kin ids). Distinct from the
    // generic free-text [tags]; written from the global Gallery's tag picker.
    var taggedKinIds: List<String> = emptyList(),
    var description: String = "",
    var isProfilePhoto: Boolean = false,
    var cloudinaryPublicId: String = "",   // parity with web MediaFile; needed for delete + Tribal Intel attachment refs
    var metadata: MediaMetadata = MediaMetadata()
)

enum class MediaType {
    IMAGE,
    VIDEO,
    DOCUMENT,
    AUDIO
}

enum class MediaEntityType {
    KINFOLK,    // Profile photos, documents
    KIN,        // Pet photos, videos, medical records
    HOUSEHOLD,  // House photos, document scans
    VISIT_LOG,  // Photos/videos from care visits
    INVOICE,    // Invoice documents, receipts
    TRAINING,   // Training videos, progress photos
    TRIBAL_INTEL, // Tribal Intel note attachments (spec 23): screenshots/files Auntie feeds the AI
    USER,       // Admin/Auntie profile avatar
    BUSINESS    // 17.2 Branding: the workspace logo (entityType "BUSINESS", matches web)
}

data class MediaMetadata(
    var width: Int? = null,
    var height: Int? = null,
    var duration: Int? = null, // For videos/audio in seconds
    var location: GeoLocation? = null,
    var cameraInfo: CameraInfo? = null,
    var visitDate: String? = null // When photo was taken during visit
)

data class GeoLocation(
    var latitude: Double = 0.0,
    var longitude: Double = 0.0,
    var accuracy: Float? = null
)

data class CameraInfo(
    var make: String? = null,
    var model: String? = null,
    var flashUsed: Boolean? = null
)

// Gallery Organization
data class MediaAlbum(
    @DocumentId val id: String = "",
    var entityId: String = "",
    var entityType: MediaEntityType = MediaEntityType.KIN,
    var albumName: String = "",
    var description: String = "",
    var coverPhotoId: String = "",
    var mediaCount: Int = 0,
    var isSystemAlbum: Boolean = false, // e.g., "Profile Photos", "Visit Logs"
    var createdAt: String = "",
    var sortOrder: Int = 0
)

data class MediaAlbumItem(
    @DocumentId val id: String = "",
    var albumId: String = "",
    var mediaFileId: String = "",
    var sortOrder: Int = 0,
    var addedAt: String = ""
)

