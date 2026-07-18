package com.tribetails.auntieos.data.model

import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.PropertyName
import com.google.gson.annotations.SerializedName

data class BaserowFile(
    val url: String = "",
    val name: String = "",
    val size: Int = 0,
    @get:PropertyName("mime_type") @set:PropertyName("mime_type") var mimeType: String = "",
    @get:PropertyName("is_image") @set:PropertyName("is_image") var isImage: Boolean = false
)

// --- Primary CRM Models (Spec-Complete) ---

data class Kinfolk(
    @DocumentId val id: String = "",
    var firstName: String = "",
    var lastName: String = "",
    var phoneNumber: String = "",
    var email: String = "",
    var profilePictureUrl: String = "",
    var status: String = "active", // active, inactive, prospect, archived
    var outstandingBalance: String = "0.00",
    var tags: List<String> = emptyList(),
    
    // Contact & Identity
    var secondaryPhone: String = "",
    var secondaryEmail: String = "",
    var preferredContactMethod: String = "Text",
    var bestTimeToContact: String = "",

    // Home & Access
    var serviceAddress: String = "",
    var gateCode: String = "",
    var parkingInstructions: String = "",
    var entryNotes: String = "",
    var wifiName: String = "",
    var wifiPassword: String = "",

    // Emergency Contacts
    var emergencyContactName: String = "",
    var emergencyContactPhone: String = "",
    var emergencyContactRelation: String = "",

    // Household-level Vet Clinic (lives on Kinfolk, not Kin)
    var vetClinicName: String = "",
    var vetClinicPhone: String = "",
    var vetClinicAddress: String = "",

    // Admin & Relationship
    var internalNotes: String = "",
    var referralSource: String = "",
    var joinDate: String = "",

    // Firebase auth uid for the Kinfolk-side MyTribe app install. Populated when
    // the kinfolk onboards in MyTribe (app links its anon/phone-auth uid to this
    // doc by phone match). Used by the Send Message workflow to resolve
    // kinfolk_id -> uid -> fcm_tokens/{uid} for FCM push.
    // Blank = MyTribe not installed yet; FCM channel must fail-loud for this kinfolk.
    var uid: String = "",

    // Time-bounded contact override - set by the reconcile pipeline when a comm
    // tells us "reach me a different way for now". When non-null AND within the
    // window, notification settings and any compose UI MUST prefer
    // [contactOverride.channel] over [preferredContactMethod]. The override
    // expires naturally when [effectiveUntil] passes; reconcile may also clear it.
    var contactOverride: ContactOverride? = null,

    // Archive metadata. Set when status="archived" via AuntieRepository.archiveKinfolk;
    // cleared on unarchive. Mirrors web KinfolkEditScreen ArchiveBlock semantics.
    var archivedAt: String = "",
    var archivedReason: String = "",
    var archivedBy: String = "",

    // Phase 14: answers to admin-authored form_schemas placed on KINFOLK
    // (appliesTo == "KINFOLK"), keyed by field id. Mirrors Kin.formValues.
    var formValues: Map<String, String> = emptyMap(),
) {
    val displayName: String get() = "$firstName $lastName".trim().ifBlank { "Unnamed Kinfolk" }
    val isArchived: Boolean get() = status.equals("archived", ignoreCase = true)
}

/**
 * A short-lived override on a Kinfolk's preferred contact method, written by
 * the comms reconcile pipeline when a message contains "reach me a different
 * way" intent (e.g. "I'll only be available by text this week").
 *
 * The default [preferredContactMethod] on [Kinfolk] is unchanged - this just
 * supersedes it temporarily, with full provenance back to the source message.
 */
data class ContactOverride(
    var channel: String = "",            // text, email, phone, none
    var effectiveFrom: String = "",      // ISO-8601 (inclusive)
    var effectiveUntil: String = "",     // ISO-8601 (inclusive); blank = open-ended
    var note: String = "",               // free-text reason, e.g. "on vacation, text only"
    var sourceLogType: String = "",      // sms | email | voicemail | call
    var sourceLogId: String = "",        // the log doc id that produced this override
    var setAt: String = "",              // when the reconcile step wrote it
)

data class Dossier(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var communicationStyle: String = "",
    var householdNotes: String = "",
    var relationshipWithAuntie: String = "",
    var importantLifeContext: String = "",
    var preferredContactMethod: String = "",
    var rawSummary: String = "",   // narrative prose - see ANNOTATION_CONVENTIONS below
    var tldr: String = "",         // AI-generated 1-2 sentence summary; blank until reconcile writes it
    var media: List<BaserowFile> = emptyList(),

    // Reconciliation provenance - set every time the comms pipeline merges a new
    // fact into [rawSummary] or any structured field above.
    var lastReconciledAt: String = "",
    var lastReconcileSourceLogIds: List<String> = emptyList(),  // most recent first
    var needsMoreSamples: Boolean = false,
)

data class Kin(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var name: String = "",
    var species: String = "Dog",
    var breed: String = "",
    var age: String = "",
    var sex: String = "",
    var weight: String = "",
    var photos: List<BaserowFile> = emptyList(),
    var status: String = "active",
    var profilePictureUrl: String = "",   // Kin (pet) photo; parity with web Kin.profilePictureUrl

    // Extended fields from migration data
    var colorMarkings: String = "",
    var spayedNeutered: Boolean = false,
    var staysAs: String = "",
    var routine: String = "",
    var trainingCommands: String = "",
    var feedingBrand: String = "",
    var vaccinations: String = "",
    var medicationHealthNotes: String = "",
    var vetInfo: String = "",
    var checklist: String = "",
    var reactive: Boolean = false,
    var ownerEmail: String = "",
    var ownerPhone: String = "",
    var officeNotes: String = "",
    // Structured per-kin values for dynamic KIN form_schemas (appliesTo=KIN), e.g. the
    // precare checklist (spec 06 item 5 / 1C). Keyed by FormSchemaField.key. Supersedes
    // the free-text [checklist] blob, which is kept read-only (no data loss).
    var formValues: Map<String, String> = emptyMap()
)

data class Kin411(
    @DocumentId val id: String = "",
    var kinId: String = "",
    var breed: String = "",
    var personality: String = "",
    var quirksAndPreferences: String = "",
    var medicalNotes: String = "",
    var dietaryDetails: String = "",
    var rawSummary: String = "",   // narrative prose - see ANNOTATION_CONVENTIONS below
    var tldr: String = "",         // AI-generated 1-2 sentence summary; blank until reconcile writes it
    var gallery: List<BaserowFile> = emptyList(),

    // Repaired for UI
    var vetName: String = "",
    var vetPhone: String = "",
    var feedingAmount: String = "",
    var feedingFrequency: String = "",
    var pottyRoutine: String = "",
    var reactive: Boolean = false,

    // Reconciliation provenance - see Dossier for shape semantics.
    var lastReconciledAt: String = "",
    var lastReconcileSourceLogIds: List<String> = emptyList(),
    var needsMoreSamples: Boolean = false,
)

/**
 * ANNOTATION_CONVENTIONS - patterns the comms reconcile pipeline writes inside
 * [Dossier.rawSummary] and [Kin411.rawSummary] so the prose stays warm + human
 * but full provenance is preserved.
 *
 *  - `[[source: <channel> on {{date}}]]`  - citation for any fact carried forward
 *      e.g. `loves gummy bears [[source: Meet & Greet]]`
 *
 *  - `{{messageReceiveDate&Time, messageID}}`  - date-stamp on a fact that
 *      *supersedes* an earlier one. The earlier statement should be kept as
 *      historical context, not deleted.
 *      e.g. `Doesn't need to be crated at night anymore starting
 *           {{2026-04-26T14:30Z, sms_3f9a1b}}.`
 *
 *  - `||CREATE TASK|| <imperative>`  - a placeholder for the far-future Task
 *      feature. The reconcile step lays these down when a comm implies a
 *      follow-up; nothing acts on them yet, but they're greppable.
 *      e.g. `||CREATE TASK|| Follow up if Dougie stopped peeing on the rug`
 */
object DossierAnnotations {
    const val CITATION_OPEN     = "[[source:"
    const val CITATION_CLOSE    = "]]"
    const val SUPERSEDE_OPEN    = "{{"
    const val SUPERSEDE_CLOSE   = "}}"
    const val TASK_MARKER       = "||CREATE TASK||"
}

// --- New Admin & Business Data Models ---

data class Invoice(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var invoiceNumber: String = "",
    var client: String = "",
    var address: String = "",
    var date: String = "",
    var terms: String = "",
    var dueDate: String = "",
    var discount: String = "",
    var total: Double = 0.0,
    var paymentsHistory: String = "",
    var amountDue: Double = 0.0,
    var status: String = "",
    var viewed: String = "",
    // Attribution fields written by backfill_structural_links.py
    var sessionIds: List<String> = emptyList(),
    @get:PropertyName("_attribution") @set:PropertyName("_attribution") var attribution: String = "",
    @get:PropertyName("_attributionAt") @set:PropertyName("_attributionAt") var attributionAt: String = "",
)

data class Payment(
    @DocumentId val id: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var client: String = "",
    var address: String = "",
    var date: String = "",
    var paymentMethod: String = "",
    var referenceNumber: String = "",
    var email: String = "",
    var tip: Double = 0.0,
    var amount: Double = 0.0,
    var notes: String = "",
    // Confident payment->invoice link (parity with web Payment). Populated by the
    // Record-Payment-on-invoice-detail flow + match_payments_to_invoices.py.
    var invoiceId: String = "",
    var invoiceNumber: String = ""
)

data class VisitLog(
    @DocumentId val id: String = "",
    var journalId: String = "",
    var submitted: String = "",
    var serviceType: String = "",
    var arrival: String = "",
    var departure: String = "",
    var kinfolkId: String = "",
    var auntieNotes: String = "",
    var rawStagingRef: String = ""
)

data class TrainingDocument(
    @DocumentId val id: String = "",
    var title: String = "",
    var content: String = "",
    var communicationType: String = "",
    var kinfolkRef: String = "",
    var uploadedAt: String = "",
    var notes: String = "",
    // Phase 12 / spec 23 Tribal Intel write fields. targetType is KINFOLK or KIN.
    var targetType: String = "",
    var targetKinfolkId: String = "",
    var targetKinId: String = "",
    var attachments: List<TrainingDocAttachment> = emptyList(),
    var reconcileStatus: String = "",
    var reconcileNotes: String = ""
)

data class TrainingDocAttachment(
    var storageUrl: String = "",
    var cloudinaryPublicId: String = "",
    var fileType: String = "",
    var mimeType: String = "",
    var fileName: String = ""
)

/**
 * Assignment fields of one MyTribe kinCare visit doc
 * (families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}). Assignment is
 * never mirrored onto kin_care_sessions, so it is read off the visit doc
 * directly. Both null on an unassigned visit.
 */
data class KinCareAssignment(
    val assignedAuntieUid: String? = null,
    val auntieDisplayName: String? = null,
)

data class KinCareSession(
    @DocumentId val id: String = "",
    var kinId: String = "",
    var kinfolkId: String = "",
    var kinIds: List<String> = emptyList(), // multiple kin per session (whole household)
    var kinfolkName: String = "",
    var sourceBookingId: String = "",      // FK -> enhanced_bookings/{id} when session originates from booking approval
    // MyTribe booking-envelope FK (separate from sourceBookingId, which points at enhanced_bookings).
    // When a session originates from an incoming MyTribe kinCare request, these locate the originating
    // doc at families/{kinfolkId}/bookings/{kinCareBatchId}/kinCares/{kinCareVisitId} so status +
    // lifecycle can be patched back for the kinfolk's live view. Null/blank for AuntieOS-native sessions.
    var kinCareBatchId: String? = null,    // -> families/{kinfolkId}/bookings/{batchId}
    var kinCareVisitId: String? = null,    // -> .../kinCares/{visitId}
    var invoiceId: String = "",            // FK -> invoices/{id} when session is attributed to an invoice
    var startTime: String = "",   // scheduled start (ISO)
    var endTime: String = "",     // scheduled end (ISO)
    var serviceType: String = "",
    var serviceDurationMinutes: Int = 0,
    var notes: String = "",                  // pre-visit notes (admin)
    var kinfolkNotes: String = "",           // pre-visit notes from kinfolk
    var status: String = VisitStatus.SCHEDULED.name,

    // Lifecycle timestamps (ISO)
    var onMyWayAt: String = "",
    var arrivedAt: String = "",
    var departedAt: String = "",
    var completedAt: String = "",

    // GPS
    var visitRouteId: String = "",        // FK -> visit_routes/{id}, set on Arrived
    var etaMinutesAway: Int = 0,          // value chosen for "On My Way"
    var gpsSummary: GpsSummary? = null,   // baked on DEPARTED via saveSessionGpsSummary; KinTale composer reads route for the GPS card

    // KinTales (visit reports) tracking
    var reportIds: List<String> = emptyList(),
    var sentReportCount: Int = 0,         // bumps when a KinTale is sent to kinfolk
    var autoCompleteEligible: Boolean = false, // set true when departed AND >=1 sent

    var createdAt: String = "",
    var updatedAt: String = "",

    // Phase 14: answers to admin-authored form_schemas. A booking-create field
    // (appliesTo == "BOOKING") and a visit-day field (appliesTo == "SESSION") both
    // persist into this one map, keyed by field id. Mirrors the web KinCareSession.
    var formValues: Map<String, String> = emptyMap(),
)

enum class VisitStatus {
    SCHEDULED,
    ON_MY_WAY,
    ARRIVED,
    DEPARTED,
    COMPLETED,
    CANCELLED
}

// KinCareReport (a "KinTale") - visit recap sent to the kinfolk after a session.
// One session can have many KinTales (multi-day visits, midway updates).
data class KinCareReport(
    @DocumentId val id: String = "",
    var sessionId: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var authorId: String = "",
    var authorDisplayName: String = "",
    var kinIds: List<String> = emptyList(),

    // Auto-prefilled from the session (so the report is self-contained)
    var serviceType: String = "",
    var visitDate: String = "",
    var arrivedAt: String = "",
    var departedAt: String = "",
    var visitRouteId: String = "",

    // Template that drives the dynamic fields. Empty = built-in default template.
    var templateId: String = "",

    // Auntie-authored cover headline. Blank means the cover falls back to the
    // "From {author} for {kinfolk}" line; never auto-filled with a derived value.
    var title: String = "",

    // Auntie's narrative
    var bodyCopy: String = "",

    // Dynamic field responses keyed by "kinId|fieldKey" (kinId blank for non-perKin fields).
    var fieldResponses: Map<String, FieldResponse> = emptyMap(),

    // Pet mood per kin (kinId -> moodOption.key from the active template).
    var petMoodSelections: Map<String, String> = emptyMap(),

    // Media: list of MediaFile IDs (uploaded via MediaUploadManager)
    var mediaFileIds: List<String> = emptyList(),

    // Draft / send lifecycle
    var status: String = ReportStatus.DRAFT.name,
    var sentAt: String = "",
    var sentVia: String = "",          // "sms" / "email" / "fcm"
    var deliveryReceiptId: String = "", // n8n message id / SMS sid / etc.

    // Orphan triage state. After the May 17 migration, 7 pre-cutover visit_logs
    // were imported with empty `kinfolkId` and `sentVia="legacy_visit_logs"`
    // (formerly `legacy_orphan`). Admins triage these via the KinTale Logs
    // screen - either assigning a kinfolk, marking as a duplicate of an
    // existing canonical report, or archiving as bad data. Triaged reports
    // are filtered out of the normal Draft / Sent / Failed buckets so admins
    // see them exactly once.
    var triageStatus: String = "",           // "" | assigned | duplicate | archived_bad_data
    var triagedAt: String = "",              // ISO-8601 timestamp
    var triagedBy: String = "",              // admin uid (auth.currentUser.uid)
    var duplicateOfReportId: String = "",    // set when triageStatus == "duplicate"
    var archiveReason: String = "",          // set when triageStatus == "archived_bad_data"

    var createdAt: String = "",
    var updatedAt: String = "",

    // Phase 14: answers to admin-authored form_schemas placed on KINTALE
    // (appliesTo == "KINTALE"), keyed by field id. DISTINCT from [fieldResponses]
    // (KinTale-template answers). Mirrors the web KinCareReport.
    var formValues: Map<String, String> = emptyMap(),
)

/**
 * True when this report is one of the post-migration orphans that has not yet
 * been triaged by an admin. Used by the KinTale Logs screen to lift the row
 * into the dedicated "Needs Triage" section and exclude it from the regular
 * Drafts / Sent / Failed buckets.
 *
 * Conditions:
 *  - `kinfolkId` is blank (we couldn't auto-link during migration)
 *  - `triageStatus` is blank (admin hasn't acted yet)
 *  - `sentVia` is one of the migration sentinel values:
 *      • "legacy_orphan"      - Pass 1 import label
 *      • "legacy_visit_logs"  - Pass 2 rename (current production label)
 */
fun KinCareReport.isUntriagedOrphan(): Boolean =
    kinfolkId.isBlank() &&
    triageStatus.isBlank() &&
    sentVia in setOf("legacy_orphan", "legacy_visit_logs")

enum class ReportStatus {
    DRAFT,
    SENT,
    FAILED
}

// --- Communications: four channel-specific log collections ---
//
// Each log is its own Firestore collection so screens can query independently
// and the reconcile pipeline can fan-in by channel. Common provenance fields
// (reconcileStatus, reconciledAt, reconcileNotes) live on every entry so the
// merge step can mark which messages have been folded into a kinfolk's
// Dossier / Kin411, which were skipped (spam, system noise), and which failed.

/** Firestore collection: voicemails */
data class VoicemailLog(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var callerNumber: String = "",
    var transcript: String = "",
    var audioUrl: String = "",
    var durationSec: Int = 0,
    var direction: String = "inbound",   // voicemails are inbound by definition; kept for shape parity
    var timestamp: String = "",          // ISO-8601
    var twilioCallSid: String = "",

    // Reply state - voicemails are responded to via SMS/email/call from the screen.
    var replyStatus: String = "unread",  // unread | read | replied | dismissed
    var repliedAt: String = "",
    var replyLogId: String = "",         // points at the SmsMessage / EmailMessage / CallLog created in response

    // Reconciliation provenance.
    var reconcileStatus: String = "pending", // pending | applied | skipped | failed
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: calls_log */
data class CallLog(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var counterpartNumber: String = "",  // the other party's number, regardless of direction
    var direction: String = "inbound",   // inbound | outbound
    var status: String = "",             // answered | missed | declined | voicemail
    var transcript: String = "",
    var recordingUrl: String = "",
    var durationSec: Int = 0,
    var timestamp: String = "",
    var twilioCallSid: String = "",
    var voicemailLogId: String = "",     // set when status=voicemail; points back at VoicemailLog

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: sms_messages - covers SMS, MMS, RCS via [subType]. */
data class SmsMessage(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var counterpartNumber: String = "",
    var direction: String = "inbound",   // inbound | outbound
    var subType: String = "sms",         // sms | mms | rcs
    var body: String = "",
    var mediaUrls: List<String> = emptyList(),
    var threadId: String = "",           // groups a kinfolk's back-and-forth
    var timestamp: String = "",
    var twilioMessageSid: String = "",
    var status: String = "",             // delivered | failed | queued | received

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: emails */
data class EmailMessage(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var fromAddress: String = "",
    var toAddresses: List<String> = emptyList(),
    var ccAddresses: List<String> = emptyList(),
    var subject: String = "",
    var body: String = "",               // plaintext rendition
    var bodyHtml: String = "",           // optional HTML body (for richer reply quoting)
    var attachmentUrls: List<String> = emptyList(),
    var threadId: String = "",
    var direction: String = "inbound",   // inbound | outbound
    var timestamp: String = "",
    var providerMessageId: String = "",  // gmail/sendgrid/etc id
    var status: String = "",             // delivered | bounced | queued | received

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

/** Firestore collection: fcm_messages - outbound push notifications from Auntie OS to a kinfolk's MyTribe app. */
data class FcmMessage(
    @DocumentId val id: String = "",
    var kinfolkId: String? = null,
    var kinfolkName: String = "",
    var uid: String = "",                // recipient firebase auth uid (fcm_tokens doc id)
    var title: String = "Auntie",
    var body: String = "",
    var direction: String = "outbound",  // outbound only for now; inbound n/a for FCM
    var timestamp: String = "",
    var fcmMessageName: String = "",     // FCM v1 response "name" field
    var status: String = "",             // delivered | failed | queued
    var errorMessage: String = "",       // populated when status=failed

    var reconcileStatus: String = "pending",
    var reconciledAt: String = "",
    var reconcileNotes: String = "",
)

// --- Legacy in-memory comms model (no Firestore collection currently writes here) ---

data class CommunicationLog(
    @DocumentId val id: String = "",
    var callSid: String = "",
    var messageSid: String = "",
    var type: String = "", 
    var status: String = "",
    var callerNumber: String = "",
    var transcript: String = "",
    var recordingUrl: String = "",
    var kinfolkId: String? = null,
    var timestamp: String = "",
    var direction: String = "inbound"
)

data class MessageEvent(
    val messageSid: String,
    val body: String,
    val senderNumber: String,
    val type: String,
    val timestamp: Long = System.currentTimeMillis(),
    val direction: String = "inbound",
    var kinfolkName: String? = null,
    var kinfolkId: String? = null
)

data class VoicemailEvent(
    val callerNumber: String,
    val transcript: String,
    val playUrl: String,
    val timestamp: Long = System.currentTimeMillis(),
    var kinfolkName: String? = null,
    var kinfolkId: String? = null
)

data class CallEvent(
    val callSid: String,
    val callerNumber: String,
    val transcript: String,
    val popupUrl: String,
    val timestamp: Long = System.currentTimeMillis(),
    var actionTaken: String = "no_response",
    var recordingUrl: String = "",
    var kinfolkName: String? = null,
    var kinfolkId: String? = null
)

// --- API Models ---


data class SendMessageRequest(
    val recipient_phone: String,
    val recipient_email: String? = null,
    val message_body: String,
    val kinfolk_id: String?,
    val channel: String = "sms"
)

data class SendMessageResponse(
    val receiptId: String = ""
)

/** Firestore collection: generated_drafts - outputs from the Generate n8n workflow,
 *  approved/edited via the AdminDashboard, then triggers the Update Profiles workflow. */
data class Draft(
    @DocumentId val id: String = "",
    var status: String = "pending",                  // pending | approved | rejected
    var generatedCopy: String = "",
    var communicationType: String = "",
    var kinfolkId: String = "",
    var kinfolkName: String = "",
    var rawNotes: String = "",
    var toneHint: String = "",
    var maxLength: String = "",
    var model: String = "",
    var createdOn: String = "",                      // ISO-8601 (legacy field name kept)
    var approvedAt: String = "",
    var approvedBy: String = "",                     // uid
)

data class GenerateResponse(
    @SerializedName("generated_copy") val generatedCopy: String = "",
    @SerializedName("draft_id") val draftId: String? = null,
    @SerializedName("kinfolk_id") val kinfolkId: String? = null,
    @SerializedName("kinfolk_name") val kinfolkName: String = "",
    @SerializedName("communication_type") val communicationType: String = "",
    val model: String = "",
    val error: String? = null
)

data class GenerateRequest(
    val communication_type: String,
    val recipient: String,
    val raw_notes: String,
    val tone_hint: String,
    val max_length: String,
    /** On regenerate: an opener the reader rejected; the generator must not reuse it. */
    val avoid_opening: String? = null,
)

data class ApproveRequest(
    val trigger_source: String = "generated_draft",
    val row_id: String = "",
    val kinfolk_id: String? = null
)

/** Run-4 #6: dog + cat breed name banks from the getBreeds callable. */
data class BreedBank(
    val dogBreeds: List<String> = emptyList(),
    val catBreeds: List<String> = emptyList(),
)

/**
 * Shared `vet_clinics` Firestore collection. Both Android + web write to this
 * single catalog so the chip selector on Kinfolk Edit can autocomplete from a
 * common pool. New entries land here when an admin types a clinic name not
 * already in the list and taps "Add new".
 */
data class VetClinic(
    @DocumentId var id: String = "",
    var name: String = "",
    var phone: String = "",
    var address: String = "",
    var notes: String = "",   // parity with web VetClinic.notes
    var website: String = "",          // clinic homepage (optional)
    var googleMapsUrl: String = "",    // deep-link to the Maps listing (optional)
    var isEmergency: Boolean = false,  // 24hr / emergency / urgent-care
    // Approval gate for the kinfolk vet bank. Admin-authored = true; a kinfolk
    // submitVetClinic lands false (pending) and is hidden from other households
    // until the operator approves. Missing (legacy) reads as approved -> default true.
    var verified: Boolean = true,
    var submittedBy: String = "",      // uid of the kinfolk who submitted a pending entry
    var createdAt: String = "",
    var updatedAt: String = "",
)

/**
 * Single doc per Firebase Auth uid in the `users` Firestore collection.
 * Mirrors the web `UserProfile` shape so admin profile state stays in sync
 * across web + Android. Photo upload goes through MediaUploadManager →
 * Cloudinary; the resulting Cloudinary URL is stored in [photoUrl].
 */
data class UserProfile(
    @DocumentId var id: String = "",
    var uid: String = "",
    var email: String = "",
    var displayName: String = "",
    var firstName: String = "",
    var lastName: String = "",
    var phone: String = "",
    var title: String = "",
    var photoUrl: String = "",
    var bio: String = "",
    var dashboardWidgets: List<String> = emptyList(),
    // 17.4 Nav editor: per-operator nav customization, ordered tokens "key" or
    // "key|Custom Label" (key = nav destination name). Absent known key = hidden; empty
    // = shipped default. Wire name matches web UserProfile.navConfig byte-for-byte.
    var navConfig: List<String> = emptyList(),
    // Per-operator UI theme preference: "LIGHT"/"DARK"/"SYSTEM"; blank falls back to the
    // app default. Shared with web/desktop on users/{uid}; kept here so an Android profile
    // save never drops the theme another platform wrote (0A).
    var themeMode: String = "",
    // 17.1 personalization keys (blank on legacy docs -> app default). accentColor:
    // "TEAL".."CORAL"; density: "COMPACT"/"NORMAL"/"ROOMY"; fontScale: "SMALL"/
    // "MEDIUM"/"LARGE". Shared with web/desktop on users/{uid}.
    var accentColor: String = "",
    var density: String = "",
    var fontScale: String = "",
    var createdAt: String = "",
    var updatedAt: String = "",
) {
    val displayLabel: String
        get() = when {
            displayName.isNotBlank() -> displayName
            firstName.isNotBlank() && lastName.isNotBlank() -> "$firstName $lastName"
            firstName.isNotBlank() -> firstName
            lastName.isNotBlank()  -> lastName
            email.isNotBlank() -> email
            else -> "Unnamed User"
        }
}
// ── Dashboard widget models (AO-35/39/40/41) ─────────────────────────────────
// Callable-backed read models for the hidden-by-default Home dashboard widgets.
// These arrive from admin-gated MyTribe callables as decoded maps (not Firestore
// toObject targets), so they carry no @DocumentId; the repo decodes them by hand.
/** AO-39 expiration-countdown row (expirations collection, via listExpirations). */
data class ExpirationItem(
    val id: String = "",
    val label: String = "",
    val dateIso: String = "",   // YYYY-MM-DD
    val kinfolkId: String = "",
    val kind: String = "",      // gateCode|vetRecord|card|license|other
)
/** AO-40 expense-quick-log row (expenses collection, via listExpenses). */
data class Expense(
    val id: String = "",
    val kind: String = "",      // gas|parking|supplies|other
    val amountCents: Int = 0,
    val note: String = "",
    val occurredAt: String = "", // ISO instant
)
/** AO-40 listExpenses envelope: the rows plus server-computed week/month totals. */
data class ExpenseSummary(
    val expenses: List<Expense> = emptyList(),
    val weekTotalCents: Int = 0,
    val monthTotalCents: Int = 0,
)
/** AO-41 supplies-tracker row (supplies collection, via listSupplies). */
data class Supply(
    val id: String = "",
    val name: String = "",
    val onHand: Int = 0,
    val par: Int = 0,           // reorder threshold; low when onHand <= par
    val unit: String = "",
)
/** AO-41 listSupplies envelope: the rows plus the low count (onHand <= par). */
data class SuppliesResult(
    val supplies: List<Supply> = emptyList(),
    val lowCount: Int = 0,
)
/** AO-35 one routed stop, in arrival order, from optimizeRoute. */
data class RouteStop(
    val order: Int = 0,
    val sessionId: String = "",
    val kinfolkId: String = "",
    val household: String = "",
    val address: String = "",
    val arrivalEta: String = "", // HH:MM
)
/** AO-35 a stop that could not be routed (household with no serviceAddress). */
data class UnroutableStop(
    val sessionId: String = "",
    val household: String = "",
    val reason: String = "",
)
/** AO-35 optimizeRoute envelope: ordered stops, totals, and fail-loud unroutables. */
data class RouteResult(
    val stops: List<RouteStop> = emptyList(),
    val totalMiles: Double = 0.0,
    val totalMinutes: Int = 0,
    val unroutable: List<UnroutableStop> = emptyList(),
)
