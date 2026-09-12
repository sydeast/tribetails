package com.tribetails.auntieos.data.model

import androidx.annotation.Keep
import com.google.firebase.firestore.DocumentId
import com.google.gson.annotations.SerializedName

// Dynamic Field Definition - defines the structure of custom fields
@Keep
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

@Keep
data class ValidationRules(
    var minLength: Int? = null,
    var maxLength: Int? = null,
    var minValue: Double? = null,
    var maxValue: Double? = null,
    var regex: String? = null,
    var customErrorMessage: String? = null
)

// Dynamic Field Value - stores the actual field data
@Keep
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
@Keep
data class HouseholdData(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",

    // ── THE CANONICAL HOUSEHOLD VET ─────────────────────────────────────────
    // Operator ruling 2026-08-01: "vet info lives on household data, it can be
    // seen on the kin profile", matching page-specs 04-kinfolk-profile.md item 3.
    //
    // A `vet_clinics` document id, NOT a copied string. Name, phone, address and
    // hours resolve through it at read time, so there is exactly ONE copy of a
    // clinic's details in the product: correcting the clinic in the manager
    // corrects it everywhere at once. That is what makes the number somebody
    // reads in an emergency a number somebody can actually fix.
    var primaryVetClinicId: String = "",
    // The 24-hour clinic. A DISTINCT practice from the primary, never folded in.
    var emergencyVetClinicId: String = "",

    // Veterinary Information: LEGACY free text, kept readable for a household
    // that predates the catalog link. Read only when the id above is blank.
    // Never authored with new text; cleared to blank once
    // `HouseholdDataViewModel.clearLegacyVetLeftovers` retires it on request
    // (issue #677). `primaryVetHours` is superseded by `vet_clinics.hours`:
    // hours belong to the practice, not to each household.
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
@Keep
data class MediaFile(
    @DocumentId val id: String = "",
    var entityId: String = "", // ID of Kinfolk/Kin/Household this media belongs to
    // String, not the MediaEntityType enum: web writes lowercase ("kinfolk") while
    // Android writes the UPPERCASE enum name, so an enum-typed setter throws under
    // toObject() on web-written docs (Class C decode crash). Read the enum via
    // [entityTypeEnum]; Android's own writes still store MediaEntityType.name.
    var entityType: String = "KIN",
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
    // #802. Video-only; 0/absent on every other type. TOP-LEVEL field, matching
    // web's `MediaFile.durationSeconds` (auntieos-admin/src/api/gallery.ts and
    // the wasm/jvm web/composeApp `MediaModels.kt`) field-for-field -- NOT the
    // nested `metadata.duration` below, which nothing on web ever writes or
    // reads. Before #802 this app decoded (and the kit's AuntieMediaCell read)
    // only `metadata.duration`, so a video uploaded from web decoded to no
    // duration at all despite web having written one under this name.
    var durationSeconds: Int = 0,
    var cloudinaryPublicId: String = "",   // parity with web MediaFile; needed for delete + Tribal Intel attachment refs
    // #593. State of the asynchronous video location-metadata strip:
    // "PENDING" | "STRIPPED" | "FAILED". A video cannot be stripped inside the
    // upload the way a photo is (#583 signs an image-only transformation), so
    // it is stripped afterwards by a Cloud Function and this records where that
    // got to. BLANK on every image and on every video predating #593; the
    // repository DELETES the key rather than writing "" (the same
    // equality-on-empty-string trap kinfolkId documents above), so a blank here
    // means "no async strip applies", never "not stripped".
    var gpsStripStatus: String = "",
    var gpsStripAttempts: Int = 0,
    var gpsStripError: String = "",
    var metadata: MediaMetadata = MediaMetadata()
) {
    /** Case-insensitive view of [entityType] as the enum; unknown -> KIN. */
    val entityTypeEnum: MediaEntityType get() = MediaEntityType.fromWire(entityType)
}

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
    BUSINESS;   // 17.2 Branding: the workspace logo (entityType "BUSINESS", matches web)

    companion object {
        /** Parse a stored entityType string case-insensitively (web writes lowercase,
         *  Android writes the UPPERCASE enum name). Unknown/blank -> KIN. */
        fun fromWire(value: String?): MediaEntityType =
            entries.firstOrNull { it.name.equals(value?.trim(), ignoreCase = true) } ?: KIN
    }
}

/**
 * The fixed entityId for BUSINESS-targeted media: there is no per-business
 * roster to pick from (exactly one operator business), so this is a constant,
 * not a picker. Matches web's `BUSINESS_ENTITY_ID` (`mediaUpload.ts`) and the
 * same literal already hardcoded at `AdminSettingsViewModel.kt`'s logo upload.
 * Used by the Gallery upload picker's "Company (no household)" target
 * (operator ruling 2026-07-31: Kinfolk do not "own" media).
 */
const val BUSINESS_ENTITY_ID = "business_settings"

@Keep
data class MediaMetadata(
    var width: Int? = null,
    var height: Int? = null,
    var duration: Int? = null, // For videos/audio in seconds
    var location: GeoLocation? = null,
    var cameraInfo: CameraInfo? = null,
    var visitDate: String? = null // When photo was taken during visit
)

@Keep
data class GeoLocation(
    var latitude: Double = 0.0,
    var longitude: Double = 0.0,
    var accuracy: Float? = null
)

@Keep
data class CameraInfo(
    var make: String? = null,
    var model: String? = null,
    var flashUsed: Boolean? = null
)

// Gallery Organization
@Keep
data class MediaAlbum(
    @DocumentId val id: String = "",
    var entityId: String = "",
    // String, not the enum: mirrors [MediaFile.entityType] (web writes lowercase).
    var entityType: String = "KIN",
    var albumName: String = "",
    var description: String = "",
    var coverPhotoId: String = "",
    var mediaCount: Int = 0,
    var isSystemAlbum: Boolean = false, // e.g., "Profile Photos", "Visit Logs"
    var createdAt: String = "",
    var sortOrder: Int = 0
)

@Keep
data class MediaAlbumItem(
    @DocumentId val id: String = "",
    var albumId: String = "",
    var mediaFileId: String = "",
    var sortOrder: Int = 0,
    var addedAt: String = ""
)

