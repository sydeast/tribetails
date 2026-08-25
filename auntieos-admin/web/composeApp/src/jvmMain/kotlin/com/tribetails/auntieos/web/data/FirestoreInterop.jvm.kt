package com.tribetails.auntieos.web.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Desktop (JVM) Firestore actuals.
 *
 * Two layers:
 *  1. [JvmFirestoreFixtures] is the TEST seam: the Roborazzi/screenshot tests set the
 *     lists they need before rendering, and the read actuals return those verbatim. When
 *     a fixture is null (i.e. the real desktop app, not a test), the actual falls through
 *     to the REAL Firestore REST layer ([JvmFirestoreRest]) using the signed-in user's
 *     token. Writes go straight to REST.
 *  2. A few GPS/media paths (breadcrumb subcollections, byte uploads) are not part of the
 *     desktop admin browse/manage surface and remain honest fail-loud stubs rather than
 *     faked.
 */
object JvmFirestoreFixtures {
    var kinfolk: List<Kinfolk>? = null
    var allKin: List<Kin>? = null
    var kinByKinfolk: Map<String, List<Kin>> = emptyMap()
    var sessions: List<KinCareSession>? = null
    var reports: List<KinCareReport>? = null
    var invoices: List<Invoice>? = null
    var payments: List<Payment>? = null
    var bookingTimeSlots: List<BookingTimeSlot>? = null
    var notifications: List<NotificationEntry>? = null
    var generatedDrafts: List<GeneratedDraft>? = null
    var bookingRequests: List<KinCareSession>? = null
    var sessionsForKinfolk: List<KinCareSession>? = null
    var provideUserProfile: Boolean = false
    var userProfile: UserProfile? = null
    var voicemails: List<VoicemailLog>? = null
    var calls: List<CallLog>? = null
    var sms: List<SmsMessage>? = null
    var emails: List<EmailMessage>? = null
    var activity: List<ActivityLogEntry>? = null
    var trainingDocs: List<TrainingDocument>? = null
    var dynamicFields: List<DynamicField>? = null
    var businessSettings: BusinessSettings? = null
    var callableResponses: Map<String, String> = emptyMap()
    var incomingKinCares: List<KinCareVisit>? = null
    /** Keyed by "familyId/batchId/visitId"; answers platformGetKinCareAssignment in tests. */
    var kinCareAssignments: Map<String, KinCareAssignment> = emptyMap()

    /**
     * NOTE-53: capture the most-recent (name -> payloadJson) pair sent to
     * [platformInvokeCallable] so tests can assert on what was included in the
     * dispatch payload without needing a real network call. Null until the first
     * callable is invoked in the current test run. Reset by [clear].
     */
    var lastCallableName: String? = null
    var lastCallablePayloadJson: String? = null

    /** True when ANY fixture is set, i.e. we are inside a screenshot test, not the live app. */
    val active: Boolean
        get() = kinfolk != null || allKin != null || sessions != null || reports != null ||
            invoices != null || payments != null || bookingTimeSlots != null || notifications != null || generatedDrafts != null ||
            bookingRequests != null || sessionsForKinfolk != null || provideUserProfile ||
            voicemails != null || calls != null || sms != null || emails != null ||
            activity != null || trainingDocs != null || dynamicFields != null ||
            businessSettings != null || callableResponses.isNotEmpty() || kinByKinfolk.isNotEmpty() ||
            incomingKinCares != null || kinCareAssignments.isNotEmpty()

    /** Reset everything to null (call in test teardown to avoid cross-test bleed). */
    fun clear() {
        kinfolk = null; allKin = null; kinByKinfolk = emptyMap()
        sessions = null; reports = null; invoices = null
        payments = null; bookingTimeSlots = null; notifications = null
        generatedDrafts = null; bookingRequests = null; sessionsForKinfolk = null
        provideUserProfile = false; userProfile = null
        voicemails = null; calls = null; sms = null; emails = null
        activity = null; trainingDocs = null; dynamicFields = null; businessSettings = null
        callableResponses = emptyMap(); incomingKinCares = null
        kinCareAssignments = emptyMap()
        lastCallableName = null; lastCallablePayloadJson = null
    }
}

private val jsonOut = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

private fun <T> fixtureFlow(fixture: List<T>): Flow<FirestoreResult<List<T>>> =
    flowOf(FirestoreResult.Data(fixture))

private fun <T> stubFlow(reason: String = "Desktop Firestore not yet implemented"): Flow<FirestoreResult<T>> =
    flowOf(FirestoreResult.Error(reason))

private fun <T> stubWriteResult(reason: String = "Not available on desktop"): WriteResult<T> = WriteResult.Err(reason)

// ── reads: fixture (test) else live REST ────────────────────────────────────

internal actual fun platformKinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>> =
    JvmFirestoreFixtures.kinfolk?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<Kinfolk>("kinfolk") }

// Stage 0I scoped streams. They honour the same fixtures so a test admin's scoped
// read uses seeded data, never live; in production they push the EQ predicate /
// doc-id GET to the server so rules don't permission-deny on an unconstrained list.
internal actual fun platformKinfolkByIdStream(kinfolkId: String): Flow<FirestoreResult<List<Kinfolk>>> =
    JvmFirestoreFixtures.kinfolk?.let { fixtureFlow(it.filter { k -> k._id == kinfolkId }) }
        ?: JvmFirestoreRest.pollingStream {
            JvmFirestoreRest.getDoc<Kinfolk>("kinfolk", kinfolkId)?.let { listOf(it) } ?: emptyList()
        }

internal actual fun platformInvoicesForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<Invoice>>> =
    JvmFirestoreFixtures.invoices?.let { fixtureFlow(it.filter { i -> i.kinfolkId == kinfolkId }) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.listWhereEq<Invoice>("invoices", "kinfolkId", kinfolkId) }

internal actual fun platformPaymentsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<Payment>>> =
    JvmFirestoreFixtures.payments?.let { fixtureFlow(it.filter { p -> p.kinfolkId == kinfolkId }) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.listWhereEq<Payment>("payments", "kinfolkId", kinfolkId) }

internal actual fun platformReportsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<KinCareReport>>> =
    JvmFirestoreFixtures.reports?.let { fixtureFlow(it.filter { r -> r.kinfolkId == kinfolkId }) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.listWhereEq<KinCareReport>("kin_care_reports", "kinfolkId", kinfolkId) }

internal actual fun platformKinStream(kinfolkId: String): Flow<FirestoreResult<List<Kin>>> =
    JvmFirestoreFixtures.kinByKinfolk[kinfolkId]?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream {
            JvmFirestoreRest.list<Kin>("kin") { it["kinfolkId"]?.jsonPrimitive?.content == kinfolkId }
        }

internal actual fun platformAllKinStream(): Flow<FirestoreResult<List<Kin>>> =
    JvmFirestoreFixtures.allKin?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<Kin>("kin") }

internal actual fun platformSessionsStream(): Flow<FirestoreResult<List<KinCareSession>>> =
    JvmFirestoreFixtures.sessions?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<KinCareSession>("kin_care_sessions") }

internal actual fun platformSessionsBySourceBookingIdStream(sourceBookingId: String): Flow<FirestoreResult<List<KinCareSession>>> =
    JvmFirestoreRest.pollingStream {
        JvmFirestoreRest.list<KinCareSession>("kin_care_sessions") { it["sourceBookingId"]?.jsonPrimitive?.content == sourceBookingId }
    }

internal actual fun platformSessionsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<KinCareSession>>> =
    JvmFirestoreFixtures.sessionsForKinfolk?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream {
            JvmFirestoreRest.list<KinCareSession>("kin_care_sessions") { it["kinfolkId"]?.jsonPrimitive?.content == kinfolkId }
        }

internal actual fun platformGeneratedDraftsStream(): Flow<FirestoreResult<List<GeneratedDraft>>> =
    JvmFirestoreFixtures.generatedDrafts?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<GeneratedDraft>("generated_drafts") }

internal actual fun platformGeneratedDraftsForKinfolkStream(
    kinfolkId: String,
): Flow<FirestoreResult<List<GeneratedDraft>>> =
    // Defensive: desktop (jvm) is always a real admin, so the scoped branch never
    // runs here in practice; still push the EQ filter to the server (snake_case
    // `kinfolk_id`, matching generate.js + the rule) so it is correct if it ever does.
    JvmFirestoreFixtures.generatedDrafts?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream {
            JvmFirestoreRest.listWhereEq<GeneratedDraft>("generated_drafts", "kinfolk_id", kinfolkId)
        }

internal actual fun platformReportsStream(): Flow<FirestoreResult<List<KinCareReport>>> =
    JvmFirestoreFixtures.reports?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<KinCareReport>("kin_care_reports") }

internal actual fun platformVoicemailsStream(): Flow<FirestoreResult<List<VoicemailLog>>> =
    JvmFirestoreFixtures.voicemails?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<VoicemailLog>("voicemails") }

internal actual fun platformCallsStream(): Flow<FirestoreResult<List<CallLog>>> =
    JvmFirestoreFixtures.calls?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<CallLog>("calls_log") }

internal actual fun platformSmsStream(): Flow<FirestoreResult<List<SmsMessage>>> =
    JvmFirestoreFixtures.sms?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<SmsMessage>("sms_messages") }

internal actual fun platformEmailsStream(): Flow<FirestoreResult<List<EmailMessage>>> =
    JvmFirestoreFixtures.emails?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<EmailMessage>("emails") }

internal actual fun platformInvoicesStream(): Flow<FirestoreResult<List<Invoice>>> =
    JvmFirestoreFixtures.invoices?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<Invoice>("invoices") }

internal actual fun platformActivityStream(): Flow<FirestoreResult<List<ActivityLogEntry>>> =
    JvmFirestoreFixtures.activity?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<ActivityLogEntry>("activity_log") }

internal actual fun platformNotificationsStream(): Flow<FirestoreResult<List<NotificationEntry>>> =
    JvmFirestoreFixtures.notifications?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream {
            // firestore.rules is recipient-scoped, so the admin can only read their own.
            val uid = jvmFirebaseUid()
            JvmFirestoreRest.list<NotificationEntry>("notifications") {
                uid == null || it["recipientUid"]?.jsonPrimitive?.content == uid
            }
        }

internal actual fun platformDossierStream(kinfolkId: String): Flow<FirestoreResult<Dossier?>> =
    JvmFirestoreRest.pollingScalar {
        JvmFirestoreRest.first<Dossier>("dossiers") { it["kinfolkId"]?.jsonPrimitive?.content == kinfolkId }
    }

internal actual fun platformKin411Stream(kinId: String): Flow<FirestoreResult<Kin411?>> =
    JvmFirestoreRest.pollingScalar {
        JvmFirestoreRest.first<Kin411>("the_411") { it["kinId"]?.jsonPrimitive?.content == kinId }
    }

internal actual fun platformPaymentsStream(): Flow<FirestoreResult<List<Payment>>> =
    JvmFirestoreFixtures.payments?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<Payment>("payments") }

internal actual fun platformBookingTimeSlotsStream(): Flow<FirestoreResult<List<BookingTimeSlot>>> =
    JvmFirestoreFixtures.bookingTimeSlots?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<BookingTimeSlot>("booking_time_slots") }

// Canonical settings doc: business_settings/business_settings (2026-06-05
// unification). Read the SPECIFIC doc id, not first() of the collection.
/**
 * ISSUE #519: the settings document exactly as this console last read it, and
 * the only thing a save is allowed to diff against.
 *
 * NULL UNTIL A READ LANDS, which is load-bearing rather than tidy: with no
 * baseline there is nothing to compare, and the save falls back to the
 * whole-object merge it has always done rather than guessing that the shipped
 * Kotlin defaults are what the server holds.
 *
 * It advances on every poll AND after every write this console makes, so a
 * second save does not re-send the first save's fields.
 */
@Volatile
private var lastLoadedBusinessSettings: BusinessSettings? = null
internal actual fun platformBusinessSettingsStream(): Flow<FirestoreResult<BusinessSettings>> =
    JvmFirestoreFixtures.businessSettings?.let { flowOf(FirestoreResult.Data(it)) }
        ?: JvmFirestoreRest.pollingScalar {
            val loaded = JvmFirestoreRest.getDoc<BusinessSettings>("business_settings", BUSINESS_SETTINGS_DOC_ID)
                ?: BusinessSettings()
            lastLoadedBusinessSettings = loaded
            loaded
        }

internal actual fun platformBookingRequestsStream(): Flow<FirestoreResult<List<KinCareSession>>> =
    JvmFirestoreFixtures.bookingRequests?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream {
            JvmFirestoreRest.list<KinCareSession>("kin_care_sessions") { it["status"]?.jsonPrimitive?.content == "DRAFT" }
        }

internal actual fun platformTrainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>> =
    JvmFirestoreFixtures.trainingDocs?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<TrainingDocument>("training_documents") }

internal actual fun platformUserProfileStream(uid: String): Flow<FirestoreResult<UserProfile?>> =
    if (JvmFirestoreFixtures.provideUserProfile) flowOf(FirestoreResult.Data(JvmFirestoreFixtures.userProfile))
    else JvmFirestoreRest.pollingScalar {
        JvmFirestoreRest.first<UserProfile>("users") { it["uid"]?.jsonPrimitive?.content == uid }
    }

internal actual fun platformVetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>> =
    JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<VetClinic>("vet_clinics") }

internal actual fun platformDynamicFieldsStream(): Flow<FirestoreResult<List<DynamicField>>> =
    JvmFirestoreFixtures.dynamicFields?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<DynamicField>("dynamic_fields") }

internal actual fun platformMediaStream(entityId: String, entityType: String): Flow<FirestoreResult<List<MediaFile>>> =
    JvmFirestoreRest.pollingStream {
        JvmFirestoreRest.list<MediaFile>("media_files") { it["entityId"]?.jsonPrimitive?.content == entityId }
    }

internal actual fun platformMediaForSessionStream(sessionId: String): Flow<FirestoreResult<List<MediaFile>>> =
    JvmFirestoreRest.pollingStream {
        JvmFirestoreRest.list<MediaFile>("media_files") { it["entityId"]?.jsonPrimitive?.content == sessionId }
    }

// #13 Gallery: full-collection + per-kinfolk media streams + a taggedKinIds-only update.
internal actual fun platformAllMediaStream(): Flow<FirestoreResult<List<MediaFile>>> =
    JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<MediaFile>("media_files") }

internal actual fun platformMediaForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<MediaFile>>> =
    JvmFirestoreRest.pollingStream {
        JvmFirestoreRest.list<MediaFile>("media_files") { it["kinfolkId"]?.jsonPrimitive?.content == kinfolkId }
    }

internal actual suspend fun platformUpdateMediaTags(mediaId: String, taggedKinIds: List<String>): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("media_files", mediaId, mapOf("taggedKinIds" to JsonArray(taggedKinIds.map { JsonPrimitive(it) }))))
        WriteResult.Ok(Unit) else WriteResult.Err("tag update failed")

// ── writes: live REST ───────────────────────────────────────────────────────

internal actual suspend fun platformCreateKinfolk(k: Kinfolk): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("kinfolk", jsonOut.encodeToString(k))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
internal actual suspend fun platformUpdateKinfolk(k: Kinfolk): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("kinfolk", k._id, jsonOut.encodeToString(k)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "update failed") }
internal actual suspend fun platformArchiveKinfolk(id: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("kinfolk", id, mapOf("status" to JsonPrimitive("archived")))) WriteResult.Ok(Unit) else WriteResult.Err("archive failed")
internal actual suspend fun platformCreateKin(k: Kin): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("kin", jsonOut.encodeToString(k))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
internal actual suspend fun platformUpdateKin(k: Kin): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("kin", k._id, jsonOut.encodeToString(k)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "update failed") }
internal actual suspend fun platformArchiveKin(id: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("kin", id, mapOf("status" to JsonPrimitive("archived")))) WriteResult.Ok(Unit) else WriteResult.Err("archive failed")
internal actual suspend fun platformPatchKinCare(id: String, patch: Map<String, String>): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("kin_care_sessions", id, patch.mapValues { JsonPrimitive(it.value) })) WriteResult.Ok(Unit) else WriteResult.Err("patch failed")

// ── voicemail reply state: `replyStatus`, and only `replyStatus` ────────────
//
// These three wrote `replied: true` and `read: true`, booleans on keys NOTHING
// reads. The state field is `replyStatus` — declared on this file's own
// `VoicemailLog`, mapped by this app's `InboxScreen.toEntry()`, written by the
// React admin (`api/inboxChannelsWrite.ts`) and by Android
// (`AuntieRepository.markVoicemailRead` / `markVoicemailReplied`), and seeded
// by `twilioInboundVoicemail`. So this client's Mark read was a write that
// changed nothing anyone could see, and its reply stamp lost the `replied`
// state entirely while still succeeding. Same three keys as the other two
// clients now, so a voicemail acted on anywhere reads the same everywhere.
//
// `repliedAt` is blank for read and for dismissed: neither is a reply, and a
// reply timestamp on either would make the field a lie.
internal actual suspend fun platformMarkVoicemailReplied(voicemailId: String, repliedAtIso: String, replyLogId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("voicemails", voicemailId, mapOf("replyStatus" to JsonPrimitive("replied"), "repliedAt" to JsonPrimitive(repliedAtIso), "replyLogId" to JsonPrimitive(replyLogId)))) WriteResult.Ok(Unit) else WriteResult.Err("update failed")
internal actual suspend fun platformMarkVoicemailRead(voicemailId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("voicemails", voicemailId, mapOf("replyStatus" to JsonPrimitive("read"), "repliedAt" to JsonPrimitive(""), "replyLogId" to JsonPrimitive("")))) WriteResult.Ok(Unit) else WriteResult.Err("update failed")
internal actual suspend fun platformMarkVoicemailDismissed(voicemailId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("voicemails", voicemailId, mapOf("replyStatus" to JsonPrimitive("dismissed"), "repliedAt" to JsonPrimitive(""), "replyLogId" to JsonPrimitive("")))) WriteResult.Ok(Unit) else WriteResult.Err("update failed")

internal actual fun platformTemplatesStream(): Flow<FirestoreResult<List<KinTaleTemplate>>> =
    JvmFirestoreRest.pollingStream { JvmFirestoreRest.list<KinTaleTemplate>("kintale_templates") }
internal actual suspend fun platformCreateKinTaleReport(report: KinCareReport): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("kin_care_reports", jsonOut.encodeToString(report))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
internal actual suspend fun platformUpdateKinTaleReport(report: KinCareReport): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("kin_care_reports", report._id, jsonOut.encodeToString(report)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "update failed") }
internal actual suspend fun platformMarkKinTaleReportSent(reportId: String, sessionId: String, sentVia: String, deliveryReceiptId: String, sentAtIso: String): WriteResult<Unit> {
    // WARNING-15: one atomic Firestore :commit. The report side flips status to
    // "SENT" (uppercase to match the wasm bridge + the report screen's
    // status=="SENT" gate); the session side uses arrayUnion(reportId) +
    // increment(1) field-transforms so concurrent sends never clobber the
    // cumulative reportIds / sentReportCount (NOTE-52: the client no longer
    // computes these). Mirrors the wasm bridge's writeBatch exactly.
    require(reportId.isNotBlank()) { "markKinTaleReportSent requires a non-blank reportId" }
    require(sessionId.isNotBlank()) { "markKinTaleReportSent requires a non-blank sessionId" }
    val ok = JvmFirestoreRest.markReportSentAtomic(
        reportId = reportId,
        sessionId = sessionId,
        sentVia = sentVia,
        deliveryReceiptId = deliveryReceiptId,
        sentAtIso = sentAtIso,
        updatedAtIso = com.tribetails.auntieos.web.util.nowIso(),
    )
    return if (ok) WriteResult.Ok(Unit) else WriteResult.Err("mark sent failed")
}
// Orphan-triage (M5): route through the `triageOrphanReport` callable, exactly
// like the wasm bridge. The server (functions/src/admin/triageOrphanReport.ts)
// writes the canonical lowercase triageStatus ('assigned'/'duplicate'/
// 'archived_bad_data'), the canonical field 'archiveReason' (NOT 'triageReason'),
// derives kinfolkName from the kinfolk/{id} doc, and emits a server-bound audit
// entry. The previous direct patchFields wrote UPPERCASE statuses + a wrong
// field name and bypassed the audit (WARNING-14).
internal actual suspend fun platformAssignKinfolkToOrphan(reportId: String, kinfolkId: String, kinfolkName: String): WriteResult<Unit> {
    val payload = buildJsonObject {
        put("action", JsonPrimitive("ASSIGN"))
        put("reportId", JsonPrimitive(reportId))
        put("kinfolkId", JsonPrimitive(kinfolkId))
        if (kinfolkName.isNotBlank()) put("suppliedName", JsonPrimitive(kinfolkName))
    }
    return when (val r = JvmFirestoreRest.callable("triageOrphanReport", jsonOut.encodeToString(JsonObject.serializer(), payload))) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}
internal actual suspend fun platformMarkOrphanReportAsDuplicate(reportId: String, duplicateOfReportId: String): WriteResult<Unit> {
    val payload = buildJsonObject {
        put("action", JsonPrimitive("DUPLICATE"))
        put("reportId", JsonPrimitive(reportId))
        put("duplicateOfReportId", JsonPrimitive(duplicateOfReportId))
    }
    return when (val r = JvmFirestoreRest.callable("triageOrphanReport", jsonOut.encodeToString(JsonObject.serializer(), payload))) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}
internal actual suspend fun platformArchiveOrphanReportAsBadData(reportId: String, reason: String): WriteResult<Unit> {
    val payload = buildJsonObject {
        put("action", JsonPrimitive("ARCHIVE"))
        put("reportId", JsonPrimitive(reportId))
        put("reason", JsonPrimitive(reason))
    }
    return when (val r = JvmFirestoreRest.callable("triageOrphanReport", jsonOut.encodeToString(JsonObject.serializer(), payload))) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}
internal actual suspend fun platformApproveGeneratedDraft(draftId: String, editedCopy: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("generated_drafts", draftId, mapOf("status" to JsonPrimitive("approved"), "generatedCopy" to JsonPrimitive(editedCopy)))) WriteResult.Ok(Unit) else WriteResult.Err("approve failed")

// GPS / media byte pipelines: not part of the desktop admin surface, kept honest fail-loud.
internal actual suspend fun platformPickAndUploadKinTaleMedia(sessionId: String, remainingSlots: Int): WriteResult<List<MediaFile>> = stubWriteResult("Media upload is mobile-only")
internal actual suspend fun platformDeleteKinTaleMedia(mediaFileId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("media_files", mediaFileId, mapOf("deleted" to JsonPrimitive(true)))) WriteResult.Ok(Unit) else WriteResult.Err("delete failed")
internal actual suspend fun platformUploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String): WriteResult<MediaFile> =
    JvmMediaUpload.upload(entityId, entityType, bytes, mimeType)
// Run-4 #4b: bulk multi-file picker is mobile/web-only on desktop (same as the
// KinTale multi path); single uploads still route through JvmMediaUpload above.
internal actual suspend fun platformPickAndUploadMedia(entityId: String, entityType: String, max: Int): WriteResult<List<MediaFile>> =
    stubWriteResult("Bulk media upload is mobile-only")
internal actual suspend fun platformDeleteMedia(mediaId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("media_files", mediaId, mapOf("deleted" to JsonPrimitive(true)))) WriteResult.Ok(Unit) else WriteResult.Err("delete failed")
internal actual suspend fun platformCreateKinTaleTemplate(template: KinTaleTemplate): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("kintale_templates", jsonOut.encodeToString(template))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
internal actual suspend fun platformUpdateKinTaleTemplate(template: KinTaleTemplate): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("kintale_templates", template._id, jsonOut.encodeToString(template)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "update failed") }
internal actual suspend fun platformDeleteKinTaleTemplate(templateId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("kintale_templates", templateId, mapOf("deleted" to JsonPrimitive(true)))) WriteResult.Ok(Unit) else WriteResult.Err("delete failed")
internal actual suspend fun platformRecordPayment(payment: Payment): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("payments", jsonOut.encodeToString(payment))) }.getOrElse { WriteResult.Err(it.message ?: "record failed") }
/**
 * Always write the canonical doc id `business_settings`, and write ONLY the
 * fields that changed since this console read the document.
 *
 * ISSUE #519. This used to serialise the whole model and merge it. `merge`
 * protects fields OUTSIDE the written map and does nothing about stale fields
 * INSIDE it, and every field of the model was inside it — so a panel saving one
 * toggle wrote all ~50 back at whatever this console had last polled, reverting
 * anything the React admin or the phone had changed since. Both of those
 * surfaces have written diffs for a while; this was the last whole-object
 * writer, and #519's three new panels multiply how often it saves.
 *
 * The stamp rides along with the changes, and ONLY with changes: an empty diff
 * writes nothing at all, because `updatedAt` says when the document last changed
 * and moving it for a save that changed nothing makes it lie. The caller still
 * gets `Ok` — "saved" and "nothing to save" are the same outcome to an operator.
 *
 * With no baseline (no read has landed yet) it falls back to the whole-object
 * merge rather than diffing against Kotlin defaults, which would write every
 * field at its shipped value.
 */
internal actual suspend fun platformSaveBusinessSettings(settings: BusinessSettings): WriteResult<Unit> =
    runCatching {
        val baseline = lastLoadedBusinessSettings
        val stampedAt = com.tribetails.auntieos.web.util.nowIso()
        if (baseline == null) {
            val stamped = settings.copy(_id = BUSINESS_SETTINGS_DOC_ID, updatedAt = stampedAt)
            JvmFirestoreRest.mergeDoc("business_settings", BUSINESS_SETTINGS_DOC_ID, jsonOut.encodeToString(stamped))
            return@runCatching WriteResult.Ok(Unit)
        }
        val changes = businessSettingsChangedFields(baseline, settings, jsonOut)
        if (changes.isEmpty()) return@runCatching WriteResult.Ok(Unit)
        val ok = JvmFirestoreRest.patchFields(
            "business_settings",
            BUSINESS_SETTINGS_DOC_ID,
            changes + mapOf("updatedAt" to JsonPrimitive(stampedAt)),
        )
        if (!ok) error("Firestore write failed")
        // The baseline moves to what the server now holds. Without this a second
        // save re-sends the first save's fields, which is the same clobber one
        // step later.
        lastLoadedBusinessSettings = settings
        WriteResult.Ok(Unit)
    }.getOrElse { WriteResult.Err(it.message ?: "save failed") }
internal actual suspend fun platformApproveBooking(bookingId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("kin_care_sessions", bookingId, mapOf("status" to JsonPrimitive("SCHEDULED")))) WriteResult.Ok(Unit) else WriteResult.Err("approve failed")
internal actual suspend fun platformRejectBooking(bookingId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("kin_care_sessions", bookingId, mapOf("status" to JsonPrimitive("REJECTED")))) WriteResult.Ok(Unit) else WriteResult.Err("reject failed")
internal actual suspend fun platformCreateBookingRequest(booking: KinCareSession): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("kin_care_sessions", jsonOut.encodeToString(booking))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
internal actual suspend fun platformSaveUserProfile(profile: UserProfile): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("users", profile.uid, jsonOut.encodeToString(profile)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "save failed") }
internal actual suspend fun platformCreateVetClinic(clinic: VetClinic): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("vet_clinics", jsonOut.encodeToString(clinic))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
internal actual suspend fun platformUpdateVetClinic(clinic: VetClinic): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("vet_clinics", clinic._id, jsonOut.encodeToString(clinic)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "update failed") }
internal actual suspend fun platformDeleteVetClinic(id: String): WriteResult<Unit> =
    runCatching { if (JvmFirestoreRest.deleteDoc("vet_clinics", id)) WriteResult.Ok(Unit) else WriteResult.Err("delete failed") }
        .getOrElse { WriteResult.Err(it.message ?: "delete failed") }
internal actual suspend fun platformLogActivity(entry: ActivityLogEntry): WriteResult<String> =
    JvmFirestoreRest.callable("logActivity", jsonOut.encodeToString(entry)).let { if (it is WriteResult.Ok) WriteResult.Ok("ok") else WriteResult.Err((it as WriteResult.Err).message) }

internal actual suspend fun platformGetHouseholdData(kinfolkId: String): WriteResult<HouseholdData?> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.first<HouseholdData>("household_data") { it["kinfolkId"]?.jsonPrimitive?.content == kinfolkId }) }.getOrElse { WriteResult.Err(it.message ?: "read failed") }
internal actual suspend fun platformSaveHouseholdData(data: HouseholdData): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("household_data", data._id.ifBlank { data.kinfolkId }, jsonOut.encodeToString(data)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "save failed") }
internal actual suspend fun platformCreateDynamicField(field: DynamicField): WriteResult<String> =
    runCatching { WriteResult.Ok(JvmFirestoreRest.addDoc("dynamic_fields", jsonOut.encodeToString(field))) }.getOrElse { WriteResult.Err(it.message ?: "create failed") }
internal actual suspend fun platformUpdateDynamicField(field: DynamicField): WriteResult<Unit> =
    runCatching { JvmFirestoreRest.setDoc("dynamic_fields", field._id, jsonOut.encodeToString(field)); WriteResult.Ok(Unit) }.getOrElse { WriteResult.Err(it.message ?: "update failed") }
internal actual suspend fun platformArchiveDynamicField(id: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("dynamic_fields", id, mapOf("status" to JsonPrimitive("archived")))) WriteResult.Ok(Unit) else WriteResult.Err("archive failed")

// GPS breadcrumb subcollections: not part of the desktop admin surface.
internal actual fun platformBreadcrumbsStream(sessionId: String): Flow<FirestoreResult<List<Breadcrumb>>> = stubFlow("GPS breadcrumbs are captured on mobile")
internal actual suspend fun platformAddBreadcrumb(sessionId: String, crumb: Breadcrumb): WriteResult<String> = stubWriteResult("GPS is mobile-only")
internal actual suspend fun platformGetBreadcrumbs(sessionId: String): WriteResult<List<Breadcrumb>> = WriteResult.Ok(emptyList())
internal actual suspend fun platformSaveSessionGpsSummary(sessionId: String, summary: GpsSummary): WriteResult<Unit> = stubWriteResult("GPS is mobile-only")
internal actual fun platformBookingNotesStream(kinfolkId: String, bookingId: String, internal: Boolean, visitId: String): Flow<FirestoreResult<List<BookingNote>>> = stubFlow("Booking notes live in a kinfolk subcollection (mobile/web)")
internal actual suspend fun platformAddBookingNote(kinfolkId: String, bookingId: String, body: String, internal: Boolean, visitId: String): WriteResult<String> = stubWriteResult("Booking notes are not wired on desktop")
// 16.5: desktop incoming-requests queue. Honours a test fixture, else a real
// collectionGroup(kinCares) where status=='requested' poll via REST (with _path
// surfaced so KinCareVisit.pathParts can recover families/{fid}/bookings/{batchId}).
internal actual fun platformIncomingKinCaresStream(): Flow<FirestoreResult<List<KinCareVisit>>> =
    JvmFirestoreFixtures.incomingKinCares?.let { fixtureFlow(it) }
        ?: JvmFirestoreRest.pollingStream {
            JvmFirestoreRest.listCollectionGroupWhereEq<KinCareVisit>("kinCares", "status", KinCareStatus.REQUESTED)
        }
internal actual suspend fun platformPatchKinCareDoc(familyId: String, batchId: String, visitId: String, patch: Map<String, String>): WriteResult<Unit> = stubWriteResult("Not wired on desktop")
// One-shot kinCare assignment read. Honours a test fixture keyed by
// "familyId/batchId/visitId", else a real REST doc GET; Ok(null) when the visit
// doc is absent so the UI renders "Unassigned" rather than an error banner.
internal actual suspend fun platformGetKinCareAssignment(familyId: String, batchId: String, visitId: String): WriteResult<KinCareAssignment?> {
    JvmFirestoreFixtures.kinCareAssignments["$familyId/$batchId/$visitId"]?.let { return WriteResult.Ok(it) }
    return runCatching {
        val doc = JvmFirestoreRest.getDocPlain("families/$familyId/bookings/$batchId/kinCares", visitId)
        WriteResult.Ok(doc?.let {
            KinCareAssignment(
                assignedAuntieUid = it["assignedAuntieUid"]?.jsonPrimitive?.contentOrNull,
                auntieDisplayName = it["auntieDisplayName"]?.jsonPrimitive?.contentOrNull,
            )
        })
    }.getOrElse { WriteResult.Err(it.message ?: "read failed") }
}

// KinTale comment thread. Desktop has no live Firestore listener, so it polls the
// getKinTaleComments callable (which requires kinfolkId, per admin rules) and parses
// the {comments:[...]} result. This is REAL, not stubbed: comments must work on desktop.
// Errors propagate through pollingStream's runCatching -> FirestoreResult.Error (fail-loud).
internal actual fun platformKinTaleCommentsStream(
    taleId: String,
    kinfolkId: String,
): Flow<FirestoreResult<List<KinTaleComment>>> {
    require(taleId.isNotBlank() && kinfolkId.isNotBlank()) {
        "kinTaleCommentsStream requires non-blank taleId and kinfolkId"
    }
    return JvmFirestoreRest.pollingStream {
        val payload = buildJsonObject {
            put("taleId", JsonPrimitive(taleId))
            put("kinfolkId", JsonPrimitive(kinfolkId))
        }
        val payloadJson = jsonOut.encodeToString(JsonObject.serializer(), payload)
        when (val r = JvmFirestoreRest.callable("getKinTaleComments", payloadJson)) {
            is WriteResult.Ok -> parseCommentsResult(r.value)
            is WriteResult.Err -> throw IllegalStateException(r.message)
        }
    }
}

/** Parse a getKinTaleComments callable `result` string ({comments:[...]}) into models, ordered by createdAtMs. */
private fun parseCommentsResult(resultJson: String): List<KinTaleComment> {
    val obj = jsonOut.parseToJsonElement(resultJson).jsonObject
    val arr = obj["comments"]?.jsonArray ?: return emptyList()
    return arr.map { el ->
        val o = el.jsonObject
        KinTaleComment(
            _id = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            authorRole = o["authorRole"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            authorUid = o["authorUid"]?.jsonPrimitive?.contentOrNull,
            guestName = o["guestName"]?.jsonPrimitive?.contentOrNull,
            body = o["body"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            parentCommentId = o["parentCommentId"]?.jsonPrimitive?.contentOrNull,
            createdAtMs = o["createdAtMs"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
        )
    }.sortedBy { it.createdAtMs ?: 0L }
}

internal actual suspend fun platformAddKinTaleComment(
    taleId: String,
    kinfolkId: String,
    body: String,
    parentCommentId: String?,
): WriteResult<String> {
    require(taleId.isNotBlank() && kinfolkId.isNotBlank()) {
        "addKinTaleComment requires non-blank taleId and kinfolkId"
    }
    require(body.isNotBlank()) { "addKinTaleComment body cannot be blank" }
    val payload = buildJsonObject {
        put("kinfolkId", JsonPrimitive(kinfolkId))
        put("taleId", JsonPrimitive(taleId))
        put("body", JsonPrimitive(body))
        if (!parentCommentId.isNullOrBlank()) put("parentCommentId", JsonPrimitive(parentCommentId))
    }
    val payloadJson = jsonOut.encodeToString(JsonObject.serializer(), payload)
    return when (val r = platformInvokeCallable("addKinTaleComment", payloadJson)) {
        is WriteResult.Ok -> {
            val commentId = runCatching {
                jsonOut.parseToJsonElement(r.value).jsonObject["commentId"]?.jsonPrimitive?.contentOrNull.orEmpty()
            }.getOrElse { "" }
            WriteResult.Ok(commentId)
        }
        is WriteResult.Err -> r
    }
}

/**
 * Issue #573: every desktop callable goes through here, so this is where the app
 * notices that the backend has ended this session.
 *
 * The decorator wraps the RAW invoke below rather than being folded into it, for
 * two reasons. The reaction needs state that outlives one call (the burst guard,
 * and the re-arm that keeps it from becoming a once-per-process latch), so it
 * has to be one object shared by every call site. And keeping the raw function
 * separate is what lets `commonTest` drive the same class with its own delegate
 * and its own sign-out, instead of asserting against real REST.
 */
private val revocationAwareCallables = RevocationAwareCallables(::rawInvokeCallable)

private suspend fun rawInvokeCallable(name: String, payloadJson: String): WriteResult<String> {
    // NOTE-53: capture for test assertions (no-op cost in prod since object fields
    // are cheap writes; the live path (else branch) still hits real REST).
    JvmFirestoreFixtures.lastCallableName = name
    JvmFirestoreFixtures.lastCallablePayloadJson = payloadJson
    return JvmFirestoreFixtures.callableResponses[name]?.let { WriteResult.Ok(it) }
        ?: JvmFirestoreRest.callable(name, payloadJson)
}

internal actual suspend fun platformInvokeCallable(name: String, payloadJson: String): WriteResult<String> =
    revocationAwareCallables.invoke(name, payloadJson)

internal actual suspend fun platformUpdateInvoiceSessionIds(invoiceId: String, sessionIds: List<String>): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("invoices", invoiceId, mapOf("sessionIds" to kotlinx.serialization.json.JsonArray(sessionIds.map { JsonPrimitive(it) })))) WriteResult.Ok(Unit) else WriteResult.Err("update failed")
internal actual suspend fun platformUpdateSessionInvoiceId(sessionId: String, invoiceId: String): WriteResult<Unit> =
    if (JvmFirestoreRest.patchFields("kin_care_sessions", sessionId, mapOf("invoiceId" to JsonPrimitive(invoiceId)))) WriteResult.Ok(Unit) else WriteResult.Err("update failed")
