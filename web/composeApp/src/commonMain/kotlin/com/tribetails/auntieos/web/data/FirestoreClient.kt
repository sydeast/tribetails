package com.tribetails.auntieos.web.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Common-side facade over Firestore. Each stream delegates to a platform-specific
 * [platformXxxStream] expect function - wasmJs binds to the Firebase Web SDK via
 * `window.__fb` (see [data/FirestoreInterop.wasmJs.kt] and [resources/index.html]).
 *
 * The Baserow→Firestore migration is incomplete and has failed multiple times,
 * so collections may be empty or sparse - every screen that reads these flows
 * MUST handle the empty case explicitly.
 */
class FirestoreClient {
    /**
     * Stage 0I: every kinfolk-related LIST stream below consults [sessionTestMode].
     * When a test admin is signed in (testTribeId claim), the client MUST constrain
     * each query to `where(kinfolkId == testTribeId)` (and the kinfolk collection to
     * the single doc whose id == testTribeId) or Firestore rules return
     * permission-denied. Out of test mode (normal admin) these read the whole
     * collection exactly as before. Set once at the app root via
     * [setSessionTestMode] right after auth resolves the claim, so the dozens of
     * screens that construct their own FirestoreClient() are all scoped from one
     * chokepoint.
     */
    companion object {
        @kotlin.concurrent.Volatile
        private var sessionTestMode: TestMode = TestMode.OFF

        /** App-root sets this once the ID token claim is read. Idempotent. */
        fun setSessionTestMode(mode: TestMode) { sessionTestMode = mode }

        /** Current session test mode (OFF for normal admin). */
        fun currentSessionTestMode(): TestMode = sessionTestMode
    }

    private val testMode: TestMode get() = sessionTestMode

    fun kinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>> {
        val scope = kinfolkScopeFilter(testMode)
        // Test admin: rules allow get of the single own-kinfolk doc but DENY a list
        // of the whole collection, so read only that doc.
        return if (scope != null) platformKinfolkByIdStream(scope).scopeKinfolk(testMode) { it._id }
        else platformKinfolkStream()
    }
    fun kinStream(kinfolkId: String): Flow<FirestoreResult<List<Kin>>> = platformKinStream(kinfolkId)
    fun allKinStream(): Flow<FirestoreResult<List<Kin>>> {
        val scope = kinfolkScopeFilter(testMode)
        return if (scope != null) platformKinStream(scope).scopeKinfolk(testMode) { it.kinfolkId }
        else platformAllKinStream()
    }
    fun sessionsStream():   Flow<FirestoreResult<List<KinCareSession>>> {
        val scope = kinfolkScopeFilter(testMode)
        return if (scope != null) platformSessionsForKinfolkStream(scope).scopeKinfolk(testMode) { it.kinfolkId }
        else platformSessionsStream()
    }
    fun sessionsBySourceBookingIdStream(sourceBookingId: String): Flow<FirestoreResult<List<KinCareSession>>> =
        platformSessionsBySourceBookingIdStream(sourceBookingId)
    fun sessionsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<KinCareSession>>> =
        platformSessionsForKinfolkStream(kinfolkId)
    fun generatedDraftsStream(): Flow<FirestoreResult<List<GeneratedDraft>>> = platformGeneratedDraftsStream()
    /**
     * Marks a generated draft as approved with the (potentially edited) copy
     * the admin is sending downstream. Writes `status="approved"`, the
     * `generatedCopy`, and an ISO `approvedAt` timestamp to
     * `generated_drafts/{draftId}`. Closes the long-standing
     * CommunicateScreen TODO that previously only pinged the n8n bridge.
     */
    suspend fun approveGeneratedDraft(draftId: String, editedCopy: String): WriteResult<Unit> =
        platformApproveGeneratedDraft(draftId, editedCopy)
    fun reportsStream():    Flow<FirestoreResult<List<KinCareReport>>>  {
        val scope = kinfolkScopeFilter(testMode)
        return if (scope != null) platformReportsForKinfolkStream(scope).scopeKinfolk(testMode) { it.kinfolkId }
        else platformReportsStream()
    }
    fun voicemailsStream(): Flow<FirestoreResult<List<VoicemailLog>>>   = platformVoicemailsStream()
    fun callsStream():      Flow<FirestoreResult<List<CallLog>>>        = platformCallsStream()
    fun smsStream():        Flow<FirestoreResult<List<SmsMessage>>>     = platformSmsStream()
    fun emailsStream():     Flow<FirestoreResult<List<EmailMessage>>>   = platformEmailsStream()
    fun invoicesStream():   Flow<FirestoreResult<List<Invoice>>> {
        val scope = kinfolkScopeFilter(testMode)
        return if (scope != null) platformInvoicesForKinfolkStream(scope).scopeKinfolk(testMode) { it.kinfolkId }
        else platformInvoicesStream()
    }
    suspend fun updateInvoiceSessionIds(invoiceId: String, sessionIds: List<String>): WriteResult<Unit> =
        platformUpdateInvoiceSessionIds(invoiceId, sessionIds)
    suspend fun updateSessionInvoiceId(sessionId: String, invoiceId: String): WriteResult<Unit> =
        platformUpdateSessionInvoiceId(sessionId, invoiceId)
    fun activityStream():   Flow<FirestoreResult<List<ActivityLogEntry>>> = platformActivityStream()
    fun notificationsStream(): Flow<FirestoreResult<List<NotificationEntry>>> = platformNotificationsStream()

    /**
     * Resolves runtime feature flags via the shared `getFeatureFlags` callable
     * (Firestore-backed: global `business_settings/feature_flags` + per-user,
     * merged server-side; see MyTribe). Returns the sparse override map of
     * `key -> bool`; the app root overlays it onto [config.FeatureFlags.DEFAULT]
     * via `FeatureFlags.fromOverrides(...)`. Unknown keys are dropped there.
     *
     * Response shape: `{ "flags": { "<key>": <bool>, ... } }`.
     */
    suspend fun getFeatureFlags(): WriteResult<Map<String, Boolean>> {
        val r = platformInvokeCallable("getFeatureFlags", "{}")
        return when (r) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val flagsObj = ffJson.parseToJsonElement(r.value).jsonObject["flags"]?.jsonObject
                val map = flagsObj?.entries
                    ?.mapNotNull { (k, v) -> v.jsonPrimitive.booleanOrNull?.let { k to it } }
                    ?.toMap()
                    ?: emptyMap()
                WriteResult.Ok(map)
            }.getOrElse { WriteResult.Err(it.message ?: "feature-flag decode failed") }
        }
    }

    private val ffJson = Json { ignoreUnknownKeys = true; isLenient = true }

    /**
     * Admin-only write of central feature flags. Merges the given `key -> bool`
     * map into `business_settings/feature_flags.flags` via the `setFeatureFlags`
     * callable (admin-gated server-side). Only keys passed here are changed.
     */
    suspend fun setFeatureFlags(flags: Map<String, Boolean>): WriteResult<Unit> {
        val payload = JsonObject(
            mapOf("flags" to JsonObject(flags.mapValues { JsonPrimitive(it.value) })),
        )
        val payloadStr = ffJson.encodeToString(JsonObject.serializer(), payload)
        return when (val r = platformInvokeCallable("setFeatureFlags", payloadStr)) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * The operator's OWN notification receive-preferences (staff/{uid}.notificationPrefs),
     * read via the `getMyAdminNotificationPrefs` admin callable. These are the admin's
     * choices, within the channels the business gate enabled, of what they actually
     * receive. Fail-loud: a callable or decode error surfaces as [WriteResult.Err].
     */
    suspend fun getMyAdminNotificationPrefs(): WriteResult<AdminNotificationPrefs> =
        CloudAdminNotificationPrefsRepository().get()

    /**
     * Persists the operator's own notification receive-preferences via the
     * `saveMyAdminNotificationPrefs` admin callable. Fail-loud on error.
     */
    suspend fun saveMyAdminNotificationPrefs(prefs: AdminNotificationPrefs): WriteResult<Unit> =
        CloudAdminNotificationPrefsRepository().save(prefs)

    /**
     * Walks the `activity_log` SHA-256 hash chain server-side via the
     * `verifyActivityLogChain` admin callable and returns the integrity verdict.
     *
     * Response shape (see MyTribe functions/src/admin/verifyActivityLogChain.ts):
     *   `{ ok, scanned, firstSeq, lastSeq, unchainedCount, anomaly?: { code, ... } }`
     */
    suspend fun verifyActivityLogChain(): WriteResult<ChainVerifyResult> {
        return when (val r = platformInvokeCallable("verifyActivityLogChain", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val o = ffJson.parseToJsonElement(r.value).jsonObject
                val an = o["anomaly"]?.jsonObject
                WriteResult.Ok(
                    ChainVerifyResult(
                        ok = o["ok"]?.jsonPrimitive?.booleanOrNull ?: false,
                        scanned = o["scanned"]?.jsonPrimitive?.intOrNull ?: 0,
                        firstSeq = o["firstSeq"]?.jsonPrimitive?.intOrNull,
                        lastSeq = o["lastSeq"]?.jsonPrimitive?.intOrNull,
                        unchainedCount = o["unchainedCount"]?.jsonPrimitive?.intOrNull ?: 0,
                        anomalyCode = an?.get("code")?.jsonPrimitive?.contentOrNull,
                        anomalySeq = an?.get("seq")?.jsonPrimitive?.intOrNull,
                        expectedEntryHash = an?.get("expectedEntryHash")?.jsonPrimitive?.contentOrNull,
                        actualEntryHash = an?.get("actualEntryHash")?.jsonPrimitive?.contentOrNull,
                    )
                )
            }.getOrElse { WriteResult.Err(it.message ?: "chain verify decode failed") }
        }
    }

    /**
     * Run-4 #6: dog + cat breed name lists for the Kin breed dropdown, from the
     * `getBreeds` callable (reads seeded `dog_breeds` / `cat_breeds`). Fail-loud:
     * a callable or decode error surfaces via [WriteResult.Err] so the UI can fall
     * back to free-text rather than silently show an empty dropdown. On desktop JVM
     * the callable is stubbed -> Err -> free-text fallback (no fabricated list).
     */
    suspend fun breeds(): WriteResult<BreedLists> =
        when (val r = platformInvokeCallable("getBreeds", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> runCatching { WriteResult.Ok(decodeBreedLists(r.value)) }
                .getOrElse { WriteResult.Err(it.message ?: "breeds decode failed") }
        }

    /**
     * Run-4 #7b: the shared bank of common KinTale checklist items (defaults union the
     * admin-saved `checklist_bank`). Fail-loud via [WriteResult.Err]; the editor shows
     * the error rather than a silent-empty picker.
     */
    suspend fun listChecklistBank(): WriteResult<List<ChecklistBankItem>> =
        when (val r = platformInvokeCallable("listChecklistBank", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> runCatching { WriteResult.Ok(decodeChecklistBank(r.value)) }
                .getOrElse { WriteResult.Err(it.message ?: "checklist bank decode failed") }
        }

    /** Run-4 #7b: persist a custom checklist item to the shared bank ("Save to bank"). */
    suspend fun saveChecklistBankItem(text: String, scope: String): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("text", JsonPrimitive(text))
            put("scope", JsonPrimitive(scope))
        }
        return when (val r = platformInvokeCallable("saveChecklistBankItem", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> WriteResult.Ok(Unit)
        }
    }

    /**
     * B6: block an unavailable window so kinfolk can't book it. Writes a private
     * BLOCKED slot to `booking_time_slots` via the admin-gated createBlockedTimeSlot
     * callable; the Schedule grid renders it as a "Busy" overlay (same shape as the
     * Google-busy importer). Replaces the old admin-direct New-Visit create here.
     */
    suspend fun createBlockedTimeSlot(
        date: String,
        startTime: String,
        endTime: String,
        notes: String,
    ): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("date", JsonPrimitive(date))
            put("startTime", JsonPrimitive(startTime))
            put("endTime", JsonPrimitive(endTime))
            put("notes", JsonPrimitive(notes))
        }
        return when (val r = platformInvokeCallable("createBlockedTimeSlot", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> WriteResult.Ok(Unit)
        }
    }

    /**
     * A8 W16/W17: local forecast for the Home weather widgets via the keyless-NWS-backed
     * getLocalWeather callable. Fail-loud: a blank business address / geocode / NWS error
     * surfaces as [WriteResult.Err] (e.g. "business_address_not_set") so the widget shows
     * a real reason, never fake weather. Risk levels are derived client-side in [WeatherRisk].
     */
    suspend fun getLocalWeather(): WriteResult<com.tribetails.auntieos.web.screens.home.LocalWeather> {
        return when (val r = platformInvokeCallable("getLocalWeather", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.home.decodeLocalWeather(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "weather decode failed") }
        }
    }

    /**
     * Stage 2 step 5 (Communicate external send): send a one-off email or SMS to
     * an arbitrary recipient via the admin-gated `sendExternalMessage` callable
     * (MyTribe functions/src/admin/sendExternalMessage.ts). The server validates,
     * honors opt-outs, sends via SendGrid/Twilio, records `external_messages`, and
     * writes an EXTERNAL_MESSAGE_SENT audit entry with the recipient REDACTED.
     *
     * Returns the redacted recipient + provider message id on success. Fail-loud:
     * the consent gate (`recipient_opted_out`) and provider errors surface verbatim
     * via [WriteResult.Err] so the caller can show a clear banner. `subject` is
     * required by the server for email and ignored for SMS.
     */
    suspend fun sendExternalMessage(
        channel: String,
        to: String,
        subject: String?,
        body: String,
        transactional: Boolean = false,
    ): WriteResult<com.tribetails.auntieos.web.screens.communicate.ExternalSendResult> {
        val payloadJson = com.tribetails.auntieos.web.screens.communicate
            .externalSendPayloadJson(channel, to, subject, body, transactional)
        return when (val r = platformInvokeCallable("sendExternalMessage", payloadJson)) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.communicate.decodeExternalSendResult(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "external send decode failed") }
        }
    }

    /**
     * Communicate "Recent": recent external sends + engagement counts via the
     * admin-gated `listRecentSends` callable (external_messages has no client read
     * rule, so this is the read path). Fail-loud: callable / decode errors surface
     * via [WriteResult.Err]. Counts are bumped by the SendGrid/Twilio webhooks.
     */
    suspend fun listRecentSends(): WriteResult<List<com.tribetails.auntieos.web.screens.communicate.RecentSend>> {
        return when (val r = platformInvokeCallable("listRecentSends", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.communicate.decodeRecentSends(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "recent sends decode failed") }
        }
    }

    /**
     * Stage 2 step 5: record an opt-out for an external recipient via the
     * `suppressExternalRecipient` callable. Future [sendExternalMessage] calls to
     * the same (normalized) recipient are blocked at the source by the server's
     * consent gate. Returns the redacted recipient. Fail-loud on validation error.
     */
    suspend fun suppressExternalRecipient(
        channel: String,
        to: String,
    ): WriteResult<com.tribetails.auntieos.web.screens.communicate.SuppressResult> {
        val payload = buildJsonObject {
            put("channel", JsonPrimitive(channel))
            put("to", JsonPrimitive(to))
        }
        return when (val r = platformInvokeCallable("suppressExternalRecipient", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.communicate.decodeSuppressResult(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "suppression decode failed") }
        }
    }

    /**
     * On-demand profile synthesis ("Refresh intelligence"): triggers a reconcile
     * synthesis pass for one kinfolk via the admin-gated synthesize_kinfolk_profile
     * callable (web/functions-python/main.py). Returns Unit on success; the
     * server's processed count is informational and not surfaced (parity with the
     * Android UX). Fail-loud: a callable error or a malformed server ack surfaces
     * via [WriteResult.Err]. Routes through platformInvokeCallable so it works on
     * wasmJs + jvm (desktop). Mirrors Android AuntieRepository.synthesizeProfile.
     */
    suspend fun synthesizeProfile(kinfolkId: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
        return when (val r = platformInvokeCallable("synthesize_kinfolk_profile", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                // Validate the server ack is well-formed JSON: a garbage body is a
                // real failure, not a silent success.
                callableJson.parseToJsonElement(r.value).jsonObject
                WriteResult.Ok(Unit)
            }.getOrElse { WriteResult.Err(it.message ?: "synthesize decode failed") }
        }
    }

    /**
     * Phase 1 Communicate recipient intel: AI-generated recap of recent
     * communications for one kinfolk, via the admin-gated `recap_recent_comms`
     * callable (web/functions-python/main.py). Returns [CommsRecap] with a short
     * AI summary, the ISO timestamp of the most recent message, and the source
     * count used for the recap. Fail-loud: callable / decode errors surface via
     * [WriteResult.Err] so the UI can show a disclosed fallback.
     *
     * Response shape (firebase-bridge.js delivers callable res.data as
     * JSON.stringify, so r.value is the stringified JSON):
     *   `{ "recap": "<string>", "lastAt": "<ISO>", "sourceCount": <int> }`
     */
    suspend fun recapRecentComms(kinfolkId: String): WriteResult<CommsRecap> {
        val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
        return when (val r = platformInvokeCallable("recap_recent_comms", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val o = callableJson.parseToJsonElement(r.value).jsonObject
                WriteResult.Ok(
                    CommsRecap(
                        recap       = o["recap"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        lastAt      = o["lastAt"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        sourceCount = o["sourceCount"]?.jsonPrimitive?.intOrNull ?: 0,
                    )
                )
            }.getOrElse { WriteResult.Err(it.message ?: "recap decode failed") }
        }
    }

    /**
     * Admin-gated: clears the kinfolk's dossier householdNotes (after the admin has
     * migrated the content into structured HouseholdData). Fail-loud via WriteResult.Err.
     */
    suspend fun clearDossierHouseholdNotes(kinfolkId: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
        return when (val r = platformInvokeCallable("clear_dossier_household_notes", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                callableJson.parseToJsonElement(r.value).jsonObject
                WriteResult.Ok(Unit)
            }.getOrElse { WriteResult.Err(it.message ?: "clear notes decode failed") }
        }
    }

    /**
     * Stage 2 step 6 (Communicate broadcast): saved audience segments + a
     * multichannel broadcast. All four route through admin-gated callables
     * (MyTribe functions/src/admin/{audienceSegments,broadcastMessage}.ts) so a
     * segment is validated + audited on save, and the broadcast resolves the
     * segment server-side and fans out across in-app / email / sms / push,
     * honoring opt-outs. Fail-loud: the no_recipients / broadcast_all_failed
     * sentinels and provider errors surface verbatim via [WriteResult.Err].
     */
    suspend fun listAudienceSegments(): WriteResult<List<com.tribetails.auntieos.web.screens.communicate.AudienceSegment>> {
        return when (val r = platformInvokeCallable("listAudienceSegments", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.communicate.decodeSegments(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "segments decode failed") }
        }
    }

    suspend fun saveAudienceSegment(
        id: String?,
        name: String,
        criteria: com.tribetails.auntieos.web.screens.communicate.BroadcastCriteria,
    ): WriteResult<String> {
        val payload = buildJsonObject {
            if (!id.isNullOrBlank()) put("id", JsonPrimitive(id))
            put("name", JsonPrimitive(name))
            put("criteria", com.tribetails.auntieos.web.screens.communicate.criteriaToJson(criteria))
        }
        return when (val r = platformInvokeCallable("saveAudienceSegment", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["id"]?.jsonPrimitive?.contentOrNull.orEmpty())
            }.getOrElse { WriteResult.Err(it.message ?: "segment save decode failed") }
        }
    }

    suspend fun deleteAudienceSegment(id: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("id", JsonPrimitive(id)) }
        return when (val r = platformInvokeCallable("deleteAudienceSegment", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    suspend fun broadcastMessage(
        segmentId: String?,
        criteria: com.tribetails.auntieos.web.screens.communicate.BroadcastCriteria?,
        channels: List<com.tribetails.auntieos.web.screens.communicate.BroadcastChannel>,
        subject: String?,
        body: String,
    ): WriteResult<com.tribetails.auntieos.web.screens.communicate.BroadcastResult> {
        val payload = buildJsonObject {
            if (!segmentId.isNullOrBlank()) put("segmentId", JsonPrimitive(segmentId))
            if (criteria != null) put("criteria", com.tribetails.auntieos.web.screens.communicate.criteriaToJson(criteria))
            put("channels", buildJsonArray { channels.distinct().forEach { add(JsonPrimitive(it.wire)) } })
            if (!subject.isNullOrBlank()) put("subject", JsonPrimitive(subject))
            put("body", JsonPrimitive(body))
        }
        return when (val r = platformInvokeCallable("broadcastMessage", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.communicate.decodeBroadcastResult(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "broadcast decode failed") }
        }
    }

    /**
     * #14 (2026-06-08): invite an existing kinfolk to the kinfolk portal. Admin
     * callable (MyTribe functions/src/admin/inviteKinfolkToPortal). Resolves the
     * kinfolk's email, ensures the family envelope, and emails a PRIMARY claim
     * invite. Returns a status: sent / already_active / no_email. Fail-loud on err.
     */
    suspend fun inviteKinfolkToPortal(kinfolkId: String): WriteResult<InvitePortalResult> {
        val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
        return when (val r = platformInvokeCallable("inviteKinfolkToPortal", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.decodeFromString(InvitePortalResult.serializer(), r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "invite decode failed") }
        }
    }

    /**
     * Stage 2 step 7 (Inbox conversations / Message Auntie 16.4): two-way
     * kinfolk<->auntie threads, all via admin-gated callables (MyTribe
     * functions/src/admin/conversations.ts). listConversations -> thread list;
     * getConversationThread -> one thread's messages (clears admin unread);
     * replyToConversation -> auntie reply; markConversationRead -> clear unread.
     * Fail-loud: errors surface verbatim via WriteResult.Err.
     */
    suspend fun listConversations(): WriteResult<List<com.tribetails.auntieos.web.screens.inbox.ConversationSummary>> {
        return when (val r = platformInvokeCallable("listConversations", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.inbox.decodeConversations(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "conversations decode failed") }
        }
    }

    suspend fun getConversationThread(kinfolkId: String): WriteResult<List<com.tribetails.auntieos.web.screens.inbox.ThreadMessage>> {
        val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
        return when (val r = platformInvokeCallable("getConversationThread", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(com.tribetails.auntieos.web.screens.inbox.decodeThread(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "thread decode failed") }
        }
    }

    suspend fun replyToConversation(kinfolkId: String, body: String): WriteResult<String> {
        val payload = buildJsonObject {
            put("kinfolkId", JsonPrimitive(kinfolkId))
            put("body", JsonPrimitive(body))
        }
        return when (val r = platformInvokeCallable("replyToConversation", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["messageId"]?.jsonPrimitive?.contentOrNull.orEmpty())
            }.getOrElse { WriteResult.Err(it.message ?: "reply decode failed") }
        }
    }

    suspend fun markConversationRead(kinfolkId: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("kinfolkId", JsonPrimitive(kinfolkId)) }
        return when (val r = platformInvokeCallable("markConversationRead", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * Stage 3 / 16.2: generates a downloadable PDF of an invoice via the
     * admin-gated generateInvoicePdf callable (MyTribe renders with pdf-lib,
     * stores to Cloud Storage, returns a download-token URL). Returns the URL
     * the caller opens (launchUri on web/desktop). Fail-loud on error.
     */
    suspend fun generateInvoicePdf(invoiceId: String): WriteResult<String> {
        val payload = buildJsonObject { put("invoiceId", JsonPrimitive(invoiceId)) }
        return when (val r = platformInvokeCallable("generateInvoicePdf", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val url = callableJson.parseToJsonElement(r.value).jsonObject["pdfUrl"]?.jsonPrimitive?.contentOrNull.orEmpty()
                if (url.isBlank()) WriteResult.Err("invoice PDF: server returned no URL")
                else WriteResult.Ok(url)
            }.getOrElse { WriteResult.Err(it.message ?: "invoice PDF decode failed") }
        }
    }

    // ---- Profile reads (single-doc per kinfolk / kin) ----
    fun dossierStream(kinfolkId: String): Flow<FirestoreResult<Dossier?>>  = platformDossierStream(kinfolkId)
    fun kin411Stream(kinId: String):       Flow<FirestoreResult<Kin411?>>   = platformKin411Stream(kinId)

    // ---- Profile writes (kinfolk + kin CRUD) ----
    suspend fun createKinfolk(k: Kinfolk):   WriteResult<String> = platformCreateKinfolk(k)
    suspend fun updateKinfolk(k: Kinfolk):   WriteResult<Unit>   = platformUpdateKinfolk(k)
    suspend fun archiveKinfolk(id: String):  WriteResult<Unit>   = platformArchiveKinfolk(id)
    suspend fun createKin(k: Kin):           WriteResult<String> =
        platformCreateKin(k.copy(kinfolkId = enforceWriteKinfolkId(testMode, k.kinfolkId)))
    suspend fun updateKin(k: Kin):           WriteResult<Unit>   = platformUpdateKin(k)
    suspend fun archiveKin(id: String):      WriteResult<Unit>   = platformArchiveKin(id)

    /**
     * Patches a single Kin Care session document with the given string-valued
     * fields. Used by the Auntie Time row buttons to flip status + drop the
     * matching lifecycle timestamp in one round-trip.
     *
     * Pass empty-string to *clear* a field (e.g. on Undo Arrived).
     */
    suspend fun patchKinCare(id: String, patch: Map<String, String>): WriteResult<Unit> =
        platformPatchKinCare(id, patch)

    /** Marks a voicemail as replied and stamps reply metadata for Inbox follow-up actions. */
    suspend fun markVoicemailReplied(
        voicemailId: String,
        repliedAtIso: String,
        replyLogId: String,
    ): WriteResult<Unit> = platformMarkVoicemailReplied(voicemailId, repliedAtIso, replyLogId)

    /** Transitions a voicemail from `unread` to `read`. No-op if already read/replied/dismissed. */
    suspend fun markVoicemailRead(voicemailId: String): WriteResult<Unit> =
        platformMarkVoicemailRead(voicemailId)

    // ---- KinTale templates + reports ----
    fun templatesStream(): Flow<FirestoreResult<List<KinTaleTemplate>>> = platformTemplatesStream()

    /**
     * Best-fit active template for the given service type. Falls back to the
     * `isDefault` template, then to the built-in [DefaultKinTaleTemplate].
     * Streamed so the composer reacts to template edits made from another tab.
     */
    fun activeTemplateForService(serviceType: String): Flow<KinTaleTemplate> =
        kotlinx.coroutines.flow.flow {
            emit(DefaultKinTaleTemplate.template)
            templatesStream().collect { res ->
                if (res !is FirestoreResult.Data) return@collect
                val active = res.value.filter { it.isActive }
                val needle = serviceType.lowercase().trim()
                val match  = active.firstOrNull { tpl -> tpl.serviceTypeKeys.any { it.lowercase().trim() == needle } }
                emit(match ?: active.firstOrNull { it.isDefault } ?: DefaultKinTaleTemplate.template)
            }
        }

    suspend fun createKinTaleReport(report: KinCareReport): WriteResult<String> =
        platformCreateKinTaleReport(report.copy(kinfolkId = enforceWriteKinfolkId(testMode, report.kinfolkId)))

    suspend fun updateKinTaleReport(report: KinCareReport): WriteResult<Unit> =
        platformUpdateKinTaleReport(report)

    /**
     * Stamp the report SENT and seed the lifecycle metadata. The session-side
     * cumulative fields (reportIds / sentReportCount) are NOT passed in: each
     * platform applies them atomically (arrayUnion + increment on wasm via the
     * Firestore SDK batch, via a Firestore `:commit` transform on JVM), so two
     * concurrent sends never clobber each other's running totals (NOTE-52 / W15).
     */
    suspend fun markKinTaleReportSent(
        reportId: String,
        sessionId: String,
        sentVia: String,
        deliveryReceiptId: String,
        sentAtIso: String,
    ): WriteResult<Unit> = platformMarkKinTaleReportSent(
        reportId = reportId,
        sessionId = sessionId,
        sentVia = sentVia,
        deliveryReceiptId = deliveryReceiptId,
        sentAtIso = sentAtIso,
    )

    /**
     * Triage action: link an orphan KinCareReport to a specific kinfolk. Stamps
     * `kinfolkId` + `kinfolkName` on the report doc, flips `triageStatus` to
     * "assigned", and writes an `activity_log` entry for audit. The whole thing
     * happens in one Firestore batch so it can't half-commit.
     */
    suspend fun assignKinfolkToOrphanReport(
        reportId: String,
        kinfolkId: String,
        kinfolkName: String,
    ): WriteResult<Unit> = platformAssignKinfolkToOrphan(reportId, kinfolkId, kinfolkName)

    /**
     * Triage action: mark an orphan KinCareReport as a duplicate of an existing
     * non-orphan report. Sets `triageStatus="duplicate"` + records the master
     * report id in `duplicateOfReportId`. Audit entry written via `activity_log`.
     */
    suspend fun markOrphanReportAsDuplicate(
        reportId: String,
        duplicateOfReportId: String,
    ): WriteResult<Unit> = platformMarkOrphanReportAsDuplicate(reportId, duplicateOfReportId)

    /**
     * Triage action: archive an orphan KinCareReport as bad migration data.
     * Sets `triageStatus="archived_bad_data"` + stores the operator-supplied
     * reason in `archiveReason`. Audit entry written via `activity_log`.
     */
    suspend fun archiveOrphanReportAsBadData(
        reportId: String,
        reason: String,
    ): WriteResult<Unit> = platformArchiveOrphanReportAsBadData(reportId, reason)

    fun reportForSessionStream(sessionId: String): Flow<FirestoreResult<KinCareReport?>> =
        kotlinx.coroutines.flow.flow {
            reportsStream().collect { res ->
                when (res) {
                    is FirestoreResult.Data -> emit(FirestoreResult.Data(res.value.firstOrNull { it.sessionId == sessionId }))
                    is FirestoreResult.Error -> emit(FirestoreResult.Error(res.message))
                    FirestoreResult.Loading -> emit(FirestoreResult.Loading)
                }
            }
        }

    /**
     * Live single session for [sessionId], derived off [sessionsStream] (same
     * pattern as [reportForSessionStream]). Carries the persisted [GpsSummary] so
     * the SENT KinTale report + composer can render the real route/stats. Emits
     * null when no such session exists yet.
     */
    fun sessionForIdStream(sessionId: String): Flow<FirestoreResult<KinCareSession?>> =
        kotlinx.coroutines.flow.flow {
            sessionsStream().collect { res ->
                when (res) {
                    is FirestoreResult.Data -> emit(FirestoreResult.Data(res.value.firstOrNull { it._id == sessionId }))
                    is FirestoreResult.Error -> emit(FirestoreResult.Error(res.message))
                    FirestoreResult.Loading -> emit(FirestoreResult.Loading)
                }
            }
        }

    suspend fun saveReport(report: KinCareReport): WriteResult<String> =
        if (report._id.isBlank()) createKinTaleReport(report)
        else updateKinTaleReport(report).let { r ->
            when (r) {
                is WriteResult.Ok  -> WriteResult.Ok(report._id)
                is WriteResult.Err -> WriteResult.Err(r.message)
            }
        }

    /**
     * Send a SENT KinTale: dispatch the `report_sent` lifecycle notification via
     * the catalog-driven `dispatchVisitNotification` callable, then stamp the
     * report SENT with the first returned dispatchId as the delivery receipt
     * (sentVia="catalog"), mirroring the Android path (KinTaleReportViewModel +
     * VisitNotifier). This replaces the old [platformSendReport] which wrote an
     * empty receipt on web and was a hard stub on desktop.
     *
     * Fail-loud: a dispatch error (e.g. blank kinfolkId / sourceBookingId, missing
     * primaryUid) returns [WriteResult.Err] and the report is NOT flipped to SENT,
     * so the auntie can retry. A successful dispatch with zero channels
     * (suppressed) still sends, with a blank receipt the Delivery panel honestly
     * omits, never a faked id.
     */
    suspend fun sendReport(report: KinCareReport, session: KinCareSession): WriteResult<Unit> {
        require(report._id.isNotBlank()) { "sendReport requires a saved report (non-blank id)" }
        val familyId = session.kinfolkId
        if (familyId.isBlank()) {
            return WriteResult.Err("Cannot send: session has no kinfolk to route the KinTale to.")
        }

        // NOTE-53: prefer the server's envelope IDs (batchId + visitId) when both are
        // present and non-blank. The server callable (dispatchVisitNotification) accepts
        // EITHER the preferred form OR the legacy bookingId. Mirrors the Android
        // VisitNotifier batchId/visitId vs sourceBookingId selection logic exactly.
        val batchId = session.kinCareBatchId?.takeIf { it.isNotBlank() }
        val visitId = session.kinCareVisitId?.takeIf { it.isNotBlank() }
        val legacyBookingId = session.sourceBookingId.takeIf { it.isNotBlank() }
        val useEnvelopeIds = batchId != null && visitId != null

        if (!useEnvelopeIds && legacyBookingId == null) {
            return WriteResult.Err("Cannot send: session is not booking-originated, so the KinTale can't be routed.")
        }

        val payload = buildJsonObject {
            put("familyId", familyId)
            if (useEnvelopeIds) {
                put("batchId", batchId!!)
                put("visitId", visitId!!)
            } else {
                put("bookingId", legacyBookingId!!)
            }
            put("event", "report_sent")
        }
        val dispatchId = when (
            val r = platformInvokeCallable(
                "dispatchVisitNotification",
                callableJson.encodeToString(JsonObject.serializer(), payload),
            )
        ) {
            is WriteResult.Ok -> firstDispatchId(r.value)
            is WriteResult.Err -> return WriteResult.Err("Couldn't send: ${r.message}")
        }

        return markKinTaleReportSent(
            reportId = report._id,
            sessionId = session._id,
            sentVia = "catalog",
            deliveryReceiptId = dispatchId,
            sentAtIso = com.tribetails.auntieos.web.util.nowIso(),
        )
    }

    /**
     * Parse the first dispatchId out of a `dispatchVisitNotification` callable
     * response (`{ ok, dispatchIds, suppressed }`). Returns "" when suppressed
     * (no channels) or on a malformed body, which the receipt row then omits
     * rather than faking.
     */
    private fun firstDispatchId(dataJson: String): String = runCatching {
        callableJson.parseToJsonElement(dataJson)
            .let { it as? JsonObject ?: return@runCatching "" }["dispatchIds"]
            ?.let { it as? JsonArray }
            ?.firstOrNull()
            ?.let { (it as? JsonPrimitive)?.contentOrNull }
            .orEmpty()
    }.getOrDefault("")

    // ---- Media (Cloudinary upload + Firestore metadata) ----

    /**
     * Open the platform file picker, upload selected files to Cloudinary under
     * the visit upload preset, write a [MediaFile] doc per file to Firestore,
     * and return the saved records (with Firestore-assigned `_id`s).
     *
     * Cancelled picker → [WriteResult.Ok] with an empty list.
     */
    suspend fun pickAndUploadKinTaleMedia(
        sessionId: String,
        remainingSlots: Int,
    ): WriteResult<List<MediaFile>> =
        platformPickAndUploadKinTaleMedia(sessionId, remainingSlots)

    /** Stream of media files attached to a given Kin Care session. */
    fun mediaForSessionStream(sessionId: String): Flow<FirestoreResult<List<MediaFile>>> =
        platformMediaForSessionStream(sessionId)

    suspend fun deleteKinTaleMedia(mediaFileId: String): WriteResult<Unit> =
        platformDeleteKinTaleMedia(mediaFileId)

    fun mediaStream(entityId: String, entityType: String): Flow<FirestoreResult<List<MediaFile>>> =
        platformMediaStream(entityId, entityType)

    suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String): WriteResult<MediaFile> =
        platformUploadMedia(entityId, entityType, bytes, mimeType)

    /**
     * Run-4 #4b: pick and upload UP TO [max] files for general / business / gallery
     * media (the single [uploadMedia] above kept a max of 1, so selecting several
     * images saved one). Returns every saved record. Mirrors the multi-file KinTale
     * path; desktop JVM is the same mobile-only stub as the single path.
     */
    suspend fun pickAndUploadMedia(
        entityId: String,
        entityType: String,
        max: Int = 10,
    ): WriteResult<List<MediaFile>> =
        platformPickAndUploadMedia(entityId, entityType, max)

    suspend fun deleteMedia(mediaId: String): WriteResult<Unit> =
        platformDeleteMedia(mediaId)

    /**
     * #13 Gallery: stream of ALL business media (every entity), newest-relevant.
     * Test-admin sandbox: scoped to the test kinfolk's media (a where-query the rules
     * allow), mirroring [allKinStream]; the operator gets the full collection.
     */
    fun allMediaStream(): Flow<FirestoreResult<List<MediaFile>>> {
        val scope = kinfolkScopeFilter(testMode)
        return if (scope != null) platformMediaForKinfolkStream(scope).scopeKinfolk(testMode) { it.kinfolkId }
        else platformAllMediaStream()
    }

    /** #13 Gallery: set the kin tagged in a media file (rules gate to isAuntie/testOwns). */
    suspend fun updateMediaTags(mediaId: String, taggedKinIds: List<String>): WriteResult<Unit> =
        platformUpdateMediaTags(mediaId, taggedKinIds)

    // ---- Payments ----
    fun paymentsStream(): Flow<FirestoreResult<List<Payment>>> {
        val scope = kinfolkScopeFilter(testMode)
        return if (scope != null) platformPaymentsForKinfolkStream(scope).scopeKinfolk(testMode) { it.kinfolkId }
        else platformPaymentsStream()
    }
    suspend fun recordPayment(payment: Payment): WriteResult<String> =
        platformRecordPayment(payment.copy(kinfolkId = enforceWriteKinfolkId(testMode, payment.kinfolkId)))

    // ---- Booking time slots (availability + Google-busy blocks) ----
    /**
     * Live stream of `booking_time_slots`. The Schedule grid filters this to the
     * BLOCKED slots (`isAvailable == false`) and draws them as read-only "Busy"
     * overlays. Populated server-side by `syncGoogleCalendarBusyEvents`.
     */
    fun bookingTimeSlotsStream(): Flow<FirestoreResult<List<BookingTimeSlot>>> = platformBookingTimeSlotsStream()

    // ---- Invoices ----
    /**
     * Slice 2: server-mints a new invoice via the createInvoice callable (audit
     * BILLING_INVOICE_CREATED + invoice.new notify). Returns the new server id.
     * Routes through platformInvokeCallable so it works on both wasmJs and jvm.
     */
    suspend fun createInvoice(invoice: Invoice): WriteResult<String> {
        // Test admin: force the scoped kinfolkId so the create passes the rule.
        val scopedKinfolkId = enforceWriteKinfolkId(testMode, invoice.kinfolkId)
        val payload = buildJsonObject {
            put("familyId", JsonPrimitive(scopedKinfolkId))
            put("kinfolkName", JsonPrimitive(invoice.kinfolkName))
            put("invoiceNumber", JsonPrimitive(invoice.invoiceNumber))
            put("client", JsonPrimitive(invoice.client))
            put("address", JsonPrimitive(invoice.address))
            put("date", JsonPrimitive(invoice.date))
            put("terms", JsonPrimitive(invoice.terms))
            put("dueDate", JsonPrimitive(invoice.dueDate))
            put("discount", JsonPrimitive(invoice.discount))
            put("total", JsonPrimitive(invoice.total))
            put("amountDue", JsonPrimitive(invoice.amountDue))
            put("status", JsonPrimitive(invoice.status))
            put("sessionIds", buildJsonArray { invoice.sessionIds.forEach { add(JsonPrimitive(it)) } })
        }
        return when (val r = platformInvokeCallable("createInvoice", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["invoiceId"]?.jsonPrimitive?.contentOrNull.orEmpty())
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /** Slice 2: marks an invoice receipted (generateReceipt callable + invoice.receipt notify). */
    suspend fun generateReceipt(invoiceId: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("invoiceId", JsonPrimitive(invoiceId)) }
        return when (val r = platformInvokeCallable("generateReceipt", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * Stage 2 tail: on-demand resend of an invoice reminder for ONE invoice via
     * the sendInvoiceReminder admin callable (reuses the cron's per-invoice
     * dispatch path; stamps reminderNotifiedAtMs for idempotency). Returns the
     * invoiceId on success. Fail-loud: the server message (already-paid,
     * not-found, etc.) is surfaced verbatim.
     */
    suspend fun sendInvoiceReminder(invoiceId: String): WriteResult<String> {
        val payload = buildJsonObject { put("invoiceId", JsonPrimitive(invoiceId)) }
        return when (val r = platformInvokeCallable("sendInvoiceReminder", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(
                    callableJson.parseToJsonElement(r.value).jsonObject["invoiceId"]
                        ?.jsonPrimitive?.contentOrNull ?: invoiceId
                )
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * Stage 2 tail: transition a DRAFT invoice to sent via postInvoiceEvent.
     * postInvoiceEvent merges the supplied payload onto invoices/{invoiceId} and
     * (because the doc already exists) fires the invoice.updated notification.
     * We merge only status fields, leaving the rest of the invoice untouched.
     */
    suspend fun reviewAndSendDraftInvoice(invoiceId: String, familyId: String): WriteResult<Unit> {
        val scopedFamilyId = enforceWriteKinfolkId(testMode, familyId)
        val payload = buildJsonObject {
            put("familyId", JsonPrimitive(scopedFamilyId))
            put("invoiceId", JsonPrimitive(invoiceId))
            put("payload", buildJsonObject {
                put("status", JsonPrimitive("sent"))
            })
        }
        return when (val r = platformInvokeCallable("postInvoiceEvent", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * Stage 2 tail: apply ONE booking transition (APPROVE/REJECT/CANCEL) to many
     * individual visit ids at once via the batchUpdateBookings admin callable.
     * Returns the updated count + per-id failures. Fail-loud: per-id failures are
     * surfaced in [BatchBookingResult.failed] so callers can show updated/failed.
     */
    suspend fun batchUpdateBookings(ids: List<String>, action: String): WriteResult<BatchBookingResult> {
        val payload = buildJsonObject {
            put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } })
            put("action", JsonPrimitive(action))
        }
        return when (val r = platformInvokeCallable("batchUpdateBookings", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(decodeBatchBookingResult(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * Stage 2 tail: mark MANY notifications read at once via the
     * bulkMarkNotificationsRead callable. Returns the number actually marked
     * (ids not owned/missing are skipped server-side).
     */
    suspend fun bulkMarkNotificationsRead(ids: List<String>): WriteResult<Int> {
        val payload = buildJsonObject {
            put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } })
        }
        return when (val r = platformInvokeCallable("bulkMarkNotificationsRead", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(
                    callableJson.parseToJsonElement(r.value).jsonObject["marked"]?.jsonPrimitive?.intOrNull ?: 0
                )
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * Stage 2 Step 4: mark ONE notification read via the markNotificationRead
     * callable (stamps readAt server-side, recipient/admin guarded). Server arg
     * key is `notificationId`. Fail-loud: server message surfaced verbatim.
     */
    suspend fun markNotificationRead(notificationId: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("notificationId", JsonPrimitive(notificationId)) }
        return when (val r = platformInvokeCallable("markNotificationRead", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * Stage 2 Step 4: clear ONE notification's read markers via the
     * markNotificationUnread callable (inverse of markNotificationRead).
     */
    suspend fun markNotificationUnread(notificationId: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("notificationId", JsonPrimitive(notificationId)) }
        return when (val r = platformInvokeCallable("markNotificationUnread", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * Stage 2 Step 4: archive ONE notification out of the active inbox via the
     * archiveNotification callable (stamps archivedAt server-side). Returns the
     * number archived (0 when skipped: not owned / missing). Server arg key is
     * `id`.
     */
    suspend fun archiveNotification(notificationId: String): WriteResult<Int> {
        val payload = buildJsonObject { put("id", JsonPrimitive(notificationId)) }
        return when (val r = platformInvokeCallable("archiveNotification", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(decodeArchivedCount(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * Stage 2 Step 4: archive MANY notifications at once via the
     * bulkArchiveNotifications callable. Returns the number actually archived
     * (ids not owned/missing are skipped server-side).
     */
    suspend fun bulkArchiveNotifications(ids: List<String>): WriteResult<Int> {
        val payload = buildJsonObject {
            put("ids", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } })
        }
        return when (val r = platformInvokeCallable("bulkArchiveNotifications", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(decodeArchivedCount(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * Stage 2 Step 4: mint a QUOTE via the createQuote admin callable. A quote is
     * an invoice forced into QUOTE status server-side (the caller-supplied status
     * is ignored). [sendToKinfolk] dispatches an issued-quote notification when
     * true. Mirrors createInvoice's payload exactly. Returns the new invoice id.
     */
    suspend fun createQuote(invoice: Invoice, sendToKinfolk: Boolean): WriteResult<String> {
        val scopedKinfolkId = enforceWriteKinfolkId(testMode, invoice.kinfolkId)
        val payload = buildJsonObject {
            put("familyId", JsonPrimitive(scopedKinfolkId))
            put("kinfolkName", JsonPrimitive(invoice.kinfolkName))
            put("invoiceNumber", JsonPrimitive(invoice.invoiceNumber))
            put("client", JsonPrimitive(invoice.client))
            put("address", JsonPrimitive(invoice.address))
            put("date", JsonPrimitive(invoice.date))
            put("terms", JsonPrimitive(invoice.terms))
            put("dueDate", JsonPrimitive(invoice.dueDate))
            put("discount", JsonPrimitive(invoice.discount))
            put("total", JsonPrimitive(invoice.total))
            put("amountDue", JsonPrimitive(invoice.amountDue))
            put("status", JsonPrimitive(invoice.status))
            put("sessionIds", buildJsonArray { invoice.sessionIds.forEach { add(JsonPrimitive(it)) } })
            put("sendToKinfolk", JsonPrimitive(sendToKinfolk))
        }
        return when (val r = platformInvokeCallable("createQuote", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["invoiceId"]?.jsonPrimitive?.contentOrNull.orEmpty())
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * Stage 2 tail: the distinct set of template catalog keys currently in use,
     * via the read-only listCatalogKeys callable. Optional case-insensitive
     * substring filter.
     */
    suspend fun listCatalogKeys(filter: String? = null): WriteResult<List<String>> {
        val payload = buildJsonObject {
            if (!filter.isNullOrBlank()) put("filter", JsonPrimitive(filter))
        }
        return when (val r = platformInvokeCallable("listCatalogKeys", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(decodeCatalogKeys(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    // ---- Business settings ----
    fun businessSettingsStream(): Flow<FirestoreResult<BusinessSettings>> = platformBusinessSettingsStream()
    suspend fun saveBusinessSettings(settings: BusinessSettings): WriteResult<Unit> = platformSaveBusinessSettings(settings)

    // ---- Booking writes ----
    fun bookingRequestsStream(): Flow<FirestoreResult<List<KinCareSession>>> = platformBookingRequestsStream()
    suspend fun approveBooking(bookingId: String): WriteResult<Unit> = platformApproveBooking(bookingId)
    suspend fun rejectBooking(bookingId: String): WriteResult<Unit> = platformRejectBooking(bookingId)
    suspend fun createBookingRequest(booking: KinCareSession): WriteResult<String> =
        platformCreateBookingRequest(booking.copy(kinfolkId = enforceWriteKinfolkId(testMode, booking.kinfolkId)))

    // ---- Care-ops session callables (1E §A.9) + series approve/cancel (1G) ----
    private val callableJson = Json { ignoreUnknownKeys = true; isLenient = true }

    /** 1E §A.9: create a SCHEDULED kin_care_sessions doc (scheduleNewVisit). Returns the new id. */
    suspend fun createKinCareSession(
        kinfolkId: String,
        kinIds: List<String>,
        serviceType: String,
        startTime: String,
        endTime: String,
        serviceDurationMinutes: Int = 0,
        notes: String = "",
    ): WriteResult<String> {
        val payload = buildJsonObject {
            put("kinfolkId", JsonPrimitive(enforceWriteKinfolkId(testMode, kinfolkId)))
            put("kinIds", buildJsonArray { kinIds.forEach { add(JsonPrimitive(it)) } })
            put("serviceType", JsonPrimitive(serviceType))
            put("startTime", JsonPrimitive(startTime))
            put("endTime", JsonPrimitive(endTime))
            put("serviceDurationMinutes", JsonPrimitive(serviceDurationMinutes))
            put("notes", JsonPrimitive(notes))
        }
        return when (val r = platformInvokeCallable("createKinCareSession", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["sessionId"]?.jsonPrimitive?.contentOrNull.orEmpty())
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * AO-25: admin multi-date / recurring booking REQUEST via the
     * createMultiDateBookingRequest callable. Writes the envelope model
     * (families/{kinfolkId}/bookings) as 'requested', the Incoming-requests queue,
     * so it flows through the same approve path as a kinfolk-submitted request.
     * [visits] carry per-visit epoch-ms start times (non-consecutive dates need no
     * special handling); a weekly recurrence is expanded to concrete visits by the
     * caller and flagged via [pattern] = "weekly" + [weeklyDays].
     */
    suspend fun createMultiDateBookingRequest(
        kinfolkId: String,
        visits: List<NewBookingVisitInput>,
        notes: String? = null,
        pattern: String = "individual",
        weeklyDays: List<Int>? = null,
        kinIds: List<String>? = null,
    ): WriteResult<MultiDateBookingResult> {
        val payload = buildJsonObject {
            put("kinfolkId", JsonPrimitive(enforceWriteKinfolkId(testMode, kinfolkId)))
            put("pattern", JsonPrimitive(pattern))
            if (!notes.isNullOrBlank()) put("notes", JsonPrimitive(notes))
            weeklyDays?.let { days -> put("weeklyDays", buildJsonArray { days.forEach { add(JsonPrimitive(it)) } }) }
            kinIds?.let { ids -> put("kinIds", buildJsonArray { ids.forEach { add(JsonPrimitive(it)) } }) }
            put("visits", buildJsonArray {
                visits.forEach { v ->
                    add(buildJsonObject {
                        put("startTimeMs", JsonPrimitive(v.startTimeMs))
                        v.endTimeMs?.let { put("endTimeMs", JsonPrimitive(it)) }
                        if (!v.serviceId.isNullOrBlank()) put("serviceId", JsonPrimitive(v.serviceId))
                        put("serviceName", JsonPrimitive(v.serviceName))
                    })
                }
            })
        }
        return when (val r = platformInvokeCallable("createMultiDateBookingRequest", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val obj = callableJson.parseToJsonElement(r.value).jsonObject
                WriteResult.Ok(
                    MultiDateBookingResult(
                        batchId = obj["batchId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                        visitCount = obj["visitCount"]?.jsonPrimitive?.intOrNull ?: visits.size,
                        visitIds = (obj["visitIds"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty(),
                    ),
                )
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /** 1E §A.9: reschedule an existing session (Schedule drag / Bookings reschedule). */
    suspend fun rescheduleBooking(sessionId: String, startTime: String, endTime: String): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("sessionId", JsonPrimitive(sessionId))
            put("startTime", JsonPrimitive(startTime))
            put("endTime", JsonPrimitive(endTime))
        }
        return when (val r = platformInvokeCallable("rescheduleBooking", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * Server-bound "Set as profile photo": flips MediaFile.isProfilePhoto on the
     * chosen doc, clears it on siblings of the same entity, and stamps the
     * owning entity's photo URL field, all in one atomic admin batch. Works on
     * wasmJs and jvm (platformInvokeCallable is actual on both).
     */
    suspend fun setMediaProfilePhoto(mediaFileId: String, entityType: String, entityId: String): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("mediaFileId", JsonPrimitive(mediaFileId))
            put("entityType", JsonPrimitive(entityType))
            put("entityId", JsonPrimitive(entityId))
        }
        return when (val r = platformInvokeCallable("setMediaProfilePhoto", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /** 1G: approve/cancel a whole booking series at once (parent envelope + all
     *  child visits). Returns the full [ManageSeriesResult] so the caller can fail
     *  loud on a partial failure (failedVisits > 0). A response missing the
     *  affectedVisits field is treated as an error, not a silent 0. */
    suspend fun manageBookingSeries(action: String, kinfolkId: String, batchId: String): WriteResult<ManageSeriesResult> {
        val payload = buildJsonObject {
            put("action", JsonPrimitive(action))
            put("kinfolkId", JsonPrimitive(kinfolkId))
            put("batchId", JsonPrimitive(batchId))
        }
        return when (val r = platformInvokeCallable("manageBookingSeries", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val obj = callableJson.parseToJsonElement(r.value).jsonObject
                val affected = obj["affectedVisits"]?.jsonPrimitive?.intOrNull
                    ?: return@runCatching WriteResult.Err("manageBookingSeries: server response missing affectedVisits")
                WriteResult.Ok(
                    ManageSeriesResult(
                        affectedVisits = affected,
                        failedVisits = obj["failedVisits"]?.jsonPrimitive?.intOrNull ?: 0,
                        sessionsCreated = obj["sessionsCreated"]?.jsonPrimitive?.intOrNull ?: 0,
                    )
                )
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /**
     * Slice 8: server-side Google Calendar busy import. Calls the
     * `syncGoogleCalendarBusyEvents` admin callable, which reads the shared
     * calendar via Application Default Credentials (no key ships in any client
     * bundle) and upserts each Busy interval into `booking_time_slots` as a
     * private BLOCKED slot. Returns the imported count on success. On the
     * not-shared / not-configured paths the raw server message (which NAMES the
     * sync service account) is surfaced verbatim via WriteResult.Err so the
     * operator sees exactly which account to share with.
     */
    suspend fun syncGoogleCalendarBusyEvents(lookAheadDays: Int = 30): WriteResult<Int> {
        val payload = buildJsonObject { put("lookAheadDays", JsonPrimitive(lookAheadDays)) }
        return when (val r = platformInvokeCallable("syncGoogleCalendarBusyEvents", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(decodeImportedCount(r.value))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    // ---- Booking-envelope ingestion + write-back (gated by mytribe.booking.envelope) ----
    /** Incoming per-visit KinCare requests (collectionGroup kinCares, status == 'requested'). */
    fun incomingKinCaresStream(): Flow<FirestoreResult<List<KinCareVisit>>> = platformIncomingKinCaresStream()

    /**
     * Patches the originating kinCare doc with staff status + identity. Additive to
     * the existing kin_care_sessions write; mirrors AuntieRepository.patchKinCareDoc.
     */
    suspend fun patchKinCareDoc(
        familyId: String,
        batchId: String,
        visitId: String,
        patch: Map<String, String>,
    ): WriteResult<Unit> = platformPatchKinCareDoc(familyId, batchId, visitId, patch)

    /**
     * Assigns (auntieUid set) or unassigns (auntieUid = null) an Auntie on one
     * KinCare visit via the admin assignAuntie callable. The backend resolves
     * the display name from staff/{uid} and the onBookingsWrite trigger owns
     * the assignment notifications, so this only sends ids.
     */
    suspend fun assignAuntie(
        kinfolkId: String,
        batchId: String,
        visitId: String,
        auntieUid: String?,
    ): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("kinfolkId", JsonPrimitive(kinfolkId))
            put("batchId", JsonPrimitive(batchId))
            put("visitId", JsonPrimitive(visitId))
            put("auntieUid", auntieUid?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        return when (val r = platformInvokeCallable("assignAuntie", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /**
     * One-shot read of the assignment fields on
     * families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}. The flattened
     * kin_care_sessions copy does not carry assignment, so this is the only
     * client-side source of truth. Ok(null) when the visit doc is missing.
     */
    suspend fun kinCareAssignment(
        kinfolkId: String,
        batchId: String,
        visitId: String,
    ): WriteResult<KinCareAssignment?> = platformGetKinCareAssignment(kinfolkId, batchId, visitId)

    /**
     * The staff roster for the Assigned Auntie picker, via the admin-gated
     * listStaff callable (MyTribe functions/src/admin/listStaff.ts). The server
     * reads staff/{uid} docs and sorts by displayName, so the list renders in
     * a stable order as-is. Fail-loud: callable / decode errors surface via
     * [WriteResult.Err] so the picker shows a real reason, never a silent-empty
     * list.
     */
    suspend fun listStaff(): WriteResult<List<StaffMember>> =
        when (val r = platformInvokeCallable("listStaff", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok  -> runCatching { WriteResult.Ok(decodeStaffList(r.value)) }
                .getOrElse { WriteResult.Err(it.message ?: "staff decode failed") }
        }

    // ---- Training documents (Tribal Intel) ----
    fun trainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>> = platformTrainingDocsStream()

    private fun attachmentsJson(attachments: List<TrainingDocAttachment>) = buildJsonArray {
        attachments.forEach { a ->
            add(buildJsonObject {
                put("storageUrl", JsonPrimitive(a.storageUrl))
                put("cloudinaryPublicId", JsonPrimitive(a.cloudinaryPublicId))
                put("fileType", JsonPrimitive(a.fileType))
                put("mimeType", JsonPrimitive(a.mimeType))
                put("fileName", JsonPrimitive(a.fileName))
            })
        }
    }

    private fun trainingDocPayload(
        title: String, content: String, notes: String, communicationType: String,
        targetType: String, targetKinfolkId: String, targetKinId: String?,
        attachments: List<TrainingDocAttachment>,
    ) = buildJsonObject {
        put("title", JsonPrimitive(title))
        put("content", JsonPrimitive(content))
        put("notes", JsonPrimitive(notes))
        put("communicationType", JsonPrimitive(communicationType))
        put("targetType", JsonPrimitive(targetType))
        put("targetKinfolkId", JsonPrimitive(targetKinfolkId))
        if (!targetKinId.isNullOrBlank()) put("targetKinId", JsonPrimitive(targetKinId))
        put("attachments", attachmentsJson(attachments))
    }

    /** Spec 23: create a Tribal Intel note via admin callable. Returns the new doc id. */
    suspend fun createTrainingDocument(
        title: String, content: String, notes: String = "", communicationType: String = "note",
        targetType: String, targetKinfolkId: String, targetKinId: String? = null,
        attachments: List<TrainingDocAttachment> = emptyList(),
    ): WriteResult<String> {
        val payload = trainingDocPayload(title, content, notes, communicationType, targetType, targetKinfolkId, targetKinId, attachments)
        return when (val r = platformInvokeCallable("createTrainingDocument", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["docId"]?.jsonPrimitive?.contentOrNull.orEmpty())
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    /** Spec 23: edit a Tribal Intel note. Re-queues it for the next reconcile pass. */
    suspend fun updateTrainingDocument(
        docId: String, title: String, content: String, notes: String = "", communicationType: String = "note",
        targetType: String, targetKinfolkId: String, targetKinId: String? = null,
        attachments: List<TrainingDocAttachment> = emptyList(),
    ): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("docId", JsonPrimitive(docId))
            trainingDocPayload(title, content, notes, communicationType, targetType, targetKinfolkId, targetKinId, attachments)
                .forEach { (k, v) -> put(k, v) }
        }
        return when (val r = platformInvokeCallable("updateTrainingDocument", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /** Spec 23: delete a Tribal Intel note. Does NOT unmerge already-folded dossier/411 text. */
    suspend fun deleteTrainingDocument(docId: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("docId", JsonPrimitive(docId)) }
        return when (val r = platformInvokeCallable("deleteTrainingDocument", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    // ---- Admin / Auntie user profile (single doc per Firebase Auth uid) ----
    fun userProfileStream(uid: String): Flow<FirestoreResult<UserProfile?>> =
        platformUserProfileStream(uid)
    suspend fun saveUserProfile(profile: UserProfile): WriteResult<Unit> =
        platformSaveUserProfile(profile)

    // ---- Vet clinics (shared catalog used by Kinfolk vet section) ----
    fun vetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>> = platformVetClinicsStream()
    suspend fun createVetClinic(clinic: VetClinic): WriteResult<String> = platformCreateVetClinic(clinic)
    suspend fun updateVetClinic(clinic: VetClinic): WriteResult<Unit> = platformUpdateVetClinic(clinic)
    suspend fun deleteVetClinic(id: String): WriteResult<Unit> = platformDeleteVetClinic(id)

    // ---- Activity log writes ----
    suspend fun logActivity(entry: ActivityLogEntry): WriteResult<String> = platformLogActivity(entry)

    // ---- Household data (kinfolk-keyed dossier extension; mirrors Android port) ----
    suspend fun getHouseholdData(kinfolkId: String): WriteResult<HouseholdData?> =
        platformGetHouseholdData(kinfolkId)
    suspend fun saveHouseholdData(data: HouseholdData): WriteResult<Unit> =
        platformSaveHouseholdData(data)

    // ---- Dynamic fields (admin-defined custom fields) ----
    fun dynamicFieldsStream(): Flow<FirestoreResult<List<DynamicField>>> = platformDynamicFieldsStream()
    suspend fun createDynamicField(field: DynamicField): WriteResult<String> = platformCreateDynamicField(field)
    suspend fun updateDynamicField(field: DynamicField): WriteResult<Unit>   = platformUpdateDynamicField(field)
    suspend fun archiveDynamicField(id: String): WriteResult<Unit>           = platformArchiveDynamicField(id)

    // ---- GPS breadcrumbs (subcollection per Kin Care session) ----
    /** Live stream of every breadcrumb on a session, sorted oldest→newest. */
    fun breadcrumbsStream(sessionId: String): Flow<FirestoreResult<List<Breadcrumb>>> =
        platformBreadcrumbsStream(sessionId)
    suspend fun addBreadcrumb(sessionId: String, crumb: Breadcrumb): WriteResult<String> =
        platformAddBreadcrumb(sessionId, crumb)

    /**
     * One-shot read of a session's full breadcrumb subcollection. Used at
     * DEPARTED time to bake the session-level [GpsSummary] without keeping
     * the live snapshot listener around.
     */
    suspend fun getBreadcrumbs(sessionId: String): WriteResult<List<Breadcrumb>> =
        platformGetBreadcrumbs(sessionId)

    /**
     * Persists a finalised GPS summary onto the session doc. Single source of
     * truth for "where Auntie walked" - read by MyTribe Bookings/Schedule
     * screens for replay and by the future Departed-email flow.
     */
    suspend fun saveSessionGpsSummary(sessionId: String, summary: GpsSummary): WriteResult<Unit> =
        platformSaveSessionGpsSummary(sessionId, summary)

    // ---- Template editor writes ----
    suspend fun createKinTaleTemplate(template: KinTaleTemplate): WriteResult<String> =
        platformCreateKinTaleTemplate(template)

    suspend fun updateKinTaleTemplate(template: KinTaleTemplate): WriteResult<Unit> =
        platformUpdateKinTaleTemplate(template)

    suspend fun deleteKinTaleTemplate(templateId: String): WriteResult<Unit> =
        platformDeleteKinTaleTemplate(templateId)

    // ---- Booking notes subcollections ----
    /**
     * Live stream of notes under a booking. internal=false reads `notes/` (kinfolk-facing);
     * internal=true reads `internalNotes/` (admin-only). Path lives on MyTribe-canonical
     * `families/{kinfolkId}/bookings/{bookingId}/{notes|internalNotes}/{noteId}`.
     */
    fun bookingNotesStream(kinfolkId: String, bookingId: String, internal: Boolean, visitId: String = ""): Flow<FirestoreResult<List<BookingNote>>> =
        platformBookingNotesStream(kinfolkId, bookingId, internal, visitId)

    /**
     * Writes via Functions callable: addBookingNote (internal=false; server enforces
     * 3hr cutoff + admin/kinfolk role branching) or addInternalBookingNote (internal=true;
     * no cutoff, admin-only).
     */
    suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String, internal: Boolean): WriteResult<String> =
        platformAddBookingNote(kinfolkId, bookingId, body, internal)

    // ---- KinTale comment thread ----
    /**
     * Live stream of comments under a SENT KinTale report, ordered chronologically.
     * web/android direct-read kin_care_reports/{taleId}/comments (admin allowed per rules,
     * kinfolkId ignored); desktop jvm polls the getKinTaleComments callable (which requires
     * kinfolkId), so the signature carries kinfolkId on every platform for parity.
     */
    fun kinTaleCommentsStream(taleId: String, kinfolkId: String): Flow<FirestoreResult<List<KinTaleComment>>> =
        platformKinTaleCommentsStream(taleId, kinfolkId)

    /**
     * Posts an admin KinTale comment via the addKinTaleComment callable. Server forces
     * authorRole='admin', requires kinfolkId, validates body (non-blank, <=2000), and
     * checks parentCommentId existence when set (1-level reply).
     */
    suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?): WriteResult<String> =
        platformAddKinTaleComment(taleId, kinfolkId, body, parentCommentId)

    /**
     * Mints a read-only public share link for a SENT KinTale via the deployed
     * `createShareLink` onCall (functions/src/share/createShareLink.ts). The server
     * scrubs the report to a guest-safe payload (author, body, optional photo URLs),
     * writes a `sharedKinTales/{shareId}` doc with a TTL + revoke flag, and returns
     * `{ shareId, shareUrl }`. That shareUrl is later served read-only by the
     * `getShareLink` HTTP endpoint, which is the kinfolk-facing view of the tale.
     *
     * [familyId] is the report's `kinfolkId` (the server verifies the tale belongs to
     * that family); [kinTaleId] is the report's `_id`. Routes through
     * platformInvokeCallable so it works on wasmJs + jvm. Fail-loud: a blank/missing
     * shareUrl decodes to an Err, never a fabricated link.
     */
    suspend fun createShareLink(
        familyId: String,
        kinTaleId: String,
        includePhotos: Boolean = true,
    ): WriteResult<String> {
        val payload = buildJsonObject {
            put("familyId", JsonPrimitive(familyId))
            put("kinTaleId", JsonPrimitive(kinTaleId))
            put("includePhotos", JsonPrimitive(includePhotos))
        }
        return when (val r = platformInvokeCallable("createShareLink", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                val url = callableJson.parseToJsonElement(r.value).jsonObject["shareUrl"]
                    ?.jsonPrimitive?.contentOrNull.orEmpty()
                if (url.isBlank()) WriteResult.Err("createShareLink returned no shareUrl")
                else WriteResult.Ok(url)
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }
    }

    // ── Home dashboard widgets fan-out (AO-35 / AO-39 / AO-40 / AO-41) ──────────

    /**
     * AO-35 Route Optimizer: server-optimized visit order for [date] (YYYY-MM-DD)
     * via the admin-gated `optimizeRoute` callable (Mapbox on the server). Returns
     * the ordered stops, trip totals, and the fail-loud `unroutable` list of
     * households with no service address. Fail-loud: a missing Mapbox key or a bad
     * body surfaces via [WriteResult.Err] so the widget never fakes a route.
     */
    suspend fun optimizeRoute(date: String): WriteResult<RouteResult> {
        val payload = buildJsonObject { put("date", JsonPrimitive(date)) }
        return when (val r = platformInvokeCallable("optimizeRoute", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching { WriteResult.Ok(decodeRouteResult(r.value)) }
                .getOrElse { WriteResult.Err(it.message ?: "route decode failed") }
        }
    }

    /**
     * AO-40 Expense Quick-Log: recent expenses + week/month totals via the
     * admin-gated `listExpenses` callable (defaults to the last 30 days server-side
     * when [sinceIso] is null). Totals are server-computed (cents). Fail-loud on
     * callable / decode error.
     */
    suspend fun listExpenses(sinceIso: String? = null): WriteResult<ExpenseSummary> {
        val payload = buildJsonObject { if (!sinceIso.isNullOrBlank()) put("sinceIso", JsonPrimitive(sinceIso)) }
        return when (val r = platformInvokeCallable("listExpenses", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching { WriteResult.Ok(decodeExpenseSummary(r.value)) }
                .getOrElse { WriteResult.Err(it.message ?: "expenses decode failed") }
        }
    }

    /**
     * AO-40: record one expense via the admin-gated `logExpense` callable. Amount
     * is whole cents; [occurredAt] defaults to now server-side when null. Returns
     * the new expense id. Fail-loud on validation / callable error.
     */
    suspend fun logExpense(
        kind: String,
        amountCents: Int,
        note: String? = null,
        occurredAt: String? = null,
    ): WriteResult<String> {
        val payload = buildJsonObject {
            put("kind", JsonPrimitive(kind))
            put("amountCents", JsonPrimitive(amountCents))
            if (!note.isNullOrBlank()) put("note", JsonPrimitive(note))
            if (!occurredAt.isNullOrBlank()) put("occurredAt", JsonPrimitive(occurredAt))
        }
        return when (val r = platformInvokeCallable("logExpense", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["id"]?.jsonPrimitive?.contentOrNull.orEmpty())
            }.getOrElse { WriteResult.Err(it.message ?: "log expense decode failed") }
        }
    }

    /**
     * AO-41 Supplies Tracker: the supplies list + a server-computed [SupplySummary.
     * lowCount] (onHand <= par) via the admin-gated `listSupplies` callable.
     * Fail-loud on callable / decode error.
     */
    suspend fun listSupplies(): WriteResult<SupplySummary> {
        return when (val r = platformInvokeCallable("listSupplies", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching { WriteResult.Ok(decodeSupplySummary(r.value)) }
                .getOrElse { WriteResult.Err(it.message ?: "supplies decode failed") }
        }
    }

    /**
     * AO-41: nudge one supply's on-hand count by [delta] via the admin-gated
     * `adjustSupply` callable (server clamps at 0, fails loud if the supply is
     * missing). Returns the new on-hand count.
     */
    suspend fun adjustSupply(supplyId: String, delta: Int): WriteResult<Int> {
        val payload = buildJsonObject {
            put("supplyId", JsonPrimitive(supplyId))
            put("delta", JsonPrimitive(delta))
        }
        return when (val r = platformInvokeCallable("adjustSupply", callableJson.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(callableJson.parseToJsonElement(r.value).jsonObject["onHand"]?.jsonPrimitive?.intOrNull ?: 0)
            }.getOrElse { WriteResult.Err(it.message ?: "adjust supply decode failed") }
        }
    }

    /**
     * AO-39 Expiration Countdown: the expiration reminders (gate codes, vet
     * records, cards, licenses) via the admin-gated `listExpirations` callable
     * (server sorts by dateIso asc). Fail-loud on callable / decode error.
     */
    suspend fun listExpirations(): WriteResult<List<ExpirationItem>> {
        return when (val r = platformInvokeCallable("listExpirations", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching { WriteResult.Ok(decodeExpirations(r.value)) }
                .getOrElse { WriteResult.Err(it.message ?: "expirations decode failed") }
        }
    }
}

/** Result of a single Firestore write - Ok carries the new doc id (for creates) or Unit. */
sealed class WriteResult<out T> {
    data class Ok<T>(val value: T)        : WriteResult<T>()
    data class Err(val message: String)   : WriteResult<Nothing>()
}

/**
 * Firestore result envelope so the UI can distinguish loading (null), error,
 * and data states without losing information.
 */
sealed class FirestoreResult<out T> {
    object Loading : FirestoreResult<Nothing>()
    data class Data<T>(val value: T) : FirestoreResult<T>()
    data class Error(val message: String) : FirestoreResult<Nothing>()
}

/** #14: result of inviteKinfolkToPortal. status = sent | already_active | no_email. */
@Serializable
data class InvitePortalResult(
    val kinfolkId: String = "",
    val status: String = "",
    val inviteId: String? = null,
)

/**
 * Stage 0I belt-and-suspenders: after a kinfolk-scoped read, drop any doc that
 * somehow doesn't match the test scope (e.g. a server-side query that fell back to
 * a fixture). Out of test mode the list passes through untouched. Pairs with the
 * server-side `where(kinfolkId ==)` so a stray cross-tribe doc can never render.
 */
private inline fun <T> Flow<FirestoreResult<List<T>>>.scopeKinfolk(
    testMode: TestMode,
    crossinline kinfolkIdOf: (T) -> String,
): Flow<FirestoreResult<List<T>>> = map { res ->
    when (res) {
        is FirestoreResult.Data -> FirestoreResult.Data(applyKinfolkScope(testMode, res.value, kinfolkIdOf))
        else -> res
    }
}

internal expect fun platformKinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>>
/** Stage 0I: single-doc read of the kinfolk whose id == [kinfolkId] (test-admin scope). */
internal expect fun platformKinfolkByIdStream(kinfolkId: String): Flow<FirestoreResult<List<Kinfolk>>>
/** Stage 0I: invoices where kinfolkId == [kinfolkId] (test-admin scope). */
internal expect fun platformInvoicesForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<Invoice>>>
/** Stage 0I: payments where kinfolkId == [kinfolkId] (test-admin scope). */
internal expect fun platformPaymentsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<Payment>>>
/** Stage 0I: kin_care_reports where kinfolkId == [kinfolkId] (test-admin scope). */
internal expect fun platformReportsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<KinCareReport>>>
internal expect fun platformKinStream(kinfolkId: String): Flow<FirestoreResult<List<Kin>>>
internal expect fun platformAllKinStream(): Flow<FirestoreResult<List<Kin>>>
internal expect fun platformSessionsStream():   Flow<FirestoreResult<List<KinCareSession>>>
internal expect fun platformSessionsBySourceBookingIdStream(sourceBookingId: String): Flow<FirestoreResult<List<KinCareSession>>>
internal expect fun platformSessionsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<KinCareSession>>>
internal expect fun platformGeneratedDraftsStream(): Flow<FirestoreResult<List<GeneratedDraft>>>
internal expect suspend fun platformApproveGeneratedDraft(draftId: String, editedCopy: String): WriteResult<Unit>
internal expect fun platformReportsStream():    Flow<FirestoreResult<List<KinCareReport>>>
internal expect fun platformVoicemailsStream(): Flow<FirestoreResult<List<VoicemailLog>>>
internal expect fun platformCallsStream():      Flow<FirestoreResult<List<CallLog>>>
internal expect fun platformSmsStream():        Flow<FirestoreResult<List<SmsMessage>>>
internal expect fun platformEmailsStream():     Flow<FirestoreResult<List<EmailMessage>>>
internal expect fun platformInvoicesStream():   Flow<FirestoreResult<List<Invoice>>>
internal expect suspend fun platformUpdateInvoiceSessionIds(invoiceId: String, sessionIds: List<String>): WriteResult<Unit>
internal expect suspend fun platformUpdateSessionInvoiceId(sessionId: String, invoiceId: String): WriteResult<Unit>
internal expect fun platformActivityStream():   Flow<FirestoreResult<List<ActivityLogEntry>>>
internal expect fun platformNotificationsStream(): Flow<FirestoreResult<List<NotificationEntry>>>
internal expect fun platformDossierStream(kinfolkId: String): Flow<FirestoreResult<Dossier?>>
internal expect fun platformKin411Stream(kinId: String):      Flow<FirestoreResult<Kin411?>>

internal expect suspend fun platformCreateKinfolk(k: Kinfolk):  WriteResult<String>
internal expect suspend fun platformUpdateKinfolk(k: Kinfolk):  WriteResult<Unit>
internal expect suspend fun platformArchiveKinfolk(id: String): WriteResult<Unit>
internal expect suspend fun platformCreateKin(k: Kin):          WriteResult<String>
internal expect suspend fun platformUpdateKin(k: Kin):          WriteResult<Unit>
internal expect suspend fun platformArchiveKin(id: String):     WriteResult<Unit>
internal expect suspend fun platformPatchKinCare(id: String, patch: Map<String, String>): WriteResult<Unit>
internal expect suspend fun platformMarkVoicemailReplied(
    voicemailId: String,
    repliedAtIso: String,
    replyLogId: String,
): WriteResult<Unit>
internal expect suspend fun platformMarkVoicemailRead(voicemailId: String): WriteResult<Unit>

internal expect fun platformTemplatesStream(): Flow<FirestoreResult<List<KinTaleTemplate>>>
internal expect suspend fun platformCreateKinTaleReport(report: KinCareReport): WriteResult<String>
internal expect suspend fun platformUpdateKinTaleReport(report: KinCareReport): WriteResult<Unit>
internal expect suspend fun platformMarkKinTaleReportSent(
    reportId: String,
    sessionId: String,
    sentVia: String,
    deliveryReceiptId: String,
    sentAtIso: String,
): WriteResult<Unit>

internal expect suspend fun platformAssignKinfolkToOrphan(
    reportId: String,
    kinfolkId: String,
    kinfolkName: String,
): WriteResult<Unit>

internal expect suspend fun platformMarkOrphanReportAsDuplicate(
    reportId: String,
    duplicateOfReportId: String,
): WriteResult<Unit>

internal expect suspend fun platformArchiveOrphanReportAsBadData(
    reportId: String,
    reason: String,
): WriteResult<Unit>

internal expect suspend fun platformPickAndUploadKinTaleMedia(
    sessionId: String,
    remainingSlots: Int,
): WriteResult<List<MediaFile>>

internal expect fun platformMediaForSessionStream(sessionId: String): Flow<FirestoreResult<List<MediaFile>>>

internal expect suspend fun platformDeleteKinTaleMedia(mediaFileId: String): WriteResult<Unit>

internal expect fun platformMediaStream(entityId: String, entityType: String): Flow<FirestoreResult<List<MediaFile>>>
internal expect suspend fun platformUploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String): WriteResult<MediaFile>

// Run-4 #4b: multi-file variant for general/business/gallery media. wasm picks up to
// [max] files and writes one media_files doc each; jvm is the mobile-only stub.
internal expect suspend fun platformPickAndUploadMedia(entityId: String, entityType: String, max: Int): WriteResult<List<MediaFile>>
internal expect suspend fun platformDeleteMedia(mediaId: String): WriteResult<Unit>
internal expect fun platformAllMediaStream(): Flow<FirestoreResult<List<MediaFile>>>
internal expect fun platformMediaForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<MediaFile>>>
internal expect suspend fun platformUpdateMediaTags(mediaId: String, taggedKinIds: List<String>): WriteResult<Unit>

internal expect suspend fun platformCreateKinTaleTemplate(template: KinTaleTemplate): WriteResult<String>
internal expect suspend fun platformUpdateKinTaleTemplate(template: KinTaleTemplate): WriteResult<Unit>
internal expect suspend fun platformDeleteKinTaleTemplate(templateId: String): WriteResult<Unit>

internal expect fun platformPaymentsStream(): Flow<FirestoreResult<List<Payment>>>
internal expect fun platformBookingTimeSlotsStream(): Flow<FirestoreResult<List<BookingTimeSlot>>>
internal expect suspend fun platformRecordPayment(payment: Payment): WriteResult<String>

internal expect fun platformBusinessSettingsStream(): Flow<FirestoreResult<BusinessSettings>>
internal expect suspend fun platformSaveBusinessSettings(settings: BusinessSettings): WriteResult<Unit>

internal expect fun platformBookingRequestsStream(): Flow<FirestoreResult<List<KinCareSession>>>
internal expect suspend fun platformApproveBooking(bookingId: String): WriteResult<Unit>
internal expect suspend fun platformRejectBooking(bookingId: String): WriteResult<Unit>
internal expect suspend fun platformCreateBookingRequest(booking: KinCareSession): WriteResult<String>

// ── Booking-envelope ingestion + write-back (gated by mytribe.booking.envelope) ──
// Incoming per-visit KinCare requests, surfaced via a collectionGroup('kinCares')
// listener where status == 'requested'. Each doc carries `_path` so callers can
// derive families/{fid}/bookings/{batchId}/kinCares/{visitId} for the write-back.
internal expect fun platformIncomingKinCaresStream(): Flow<FirestoreResult<List<KinCareVisit>>>

// Patches the originating kinCare doc at
// families/{familyId}/bookings/{batchId}/kinCares/{visitId} with staff status +
// identity (the MyTribe live-state resolution path). Additive to the existing
// kin_care_sessions write - never replaces it.
internal expect suspend fun platformPatchKinCareDoc(
    familyId: String,
    batchId: String,
    visitId: String,
    patch: Map<String, String>,
): WriteResult<Unit>

// One-shot read of assignedAuntieUid + auntieDisplayName off the kinCare visit
// doc at families/{familyId}/bookings/{batchId}/kinCares/{visitId} (assignment
// is never mirrored onto the flattened kin_care_sessions doc). Ok(null) when
// the visit doc does not exist.
internal expect suspend fun platformGetKinCareAssignment(
    familyId: String,
    batchId: String,
    visitId: String,
): WriteResult<KinCareAssignment?>

internal expect fun platformTrainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>>

internal expect fun platformUserProfileStream(uid: String): Flow<FirestoreResult<UserProfile?>>
internal expect suspend fun platformSaveUserProfile(profile: UserProfile): WriteResult<Unit>

internal expect fun platformVetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>>
internal expect suspend fun platformCreateVetClinic(clinic: VetClinic): WriteResult<String>
internal expect suspend fun platformUpdateVetClinic(clinic: VetClinic): WriteResult<Unit>
internal expect suspend fun platformDeleteVetClinic(id: String): WriteResult<Unit>

internal expect suspend fun platformLogActivity(entry: ActivityLogEntry): WriteResult<String>

internal expect suspend fun platformGetHouseholdData(kinfolkId: String): WriteResult<HouseholdData?>
internal expect suspend fun platformSaveHouseholdData(data: HouseholdData): WriteResult<Unit>

internal expect fun platformDynamicFieldsStream(): Flow<FirestoreResult<List<DynamicField>>>
internal expect suspend fun platformCreateDynamicField(field: DynamicField): WriteResult<String>
internal expect suspend fun platformUpdateDynamicField(field: DynamicField): WriteResult<Unit>
internal expect suspend fun platformArchiveDynamicField(id: String): WriteResult<Unit>

internal expect fun platformBreadcrumbsStream(sessionId: String): Flow<FirestoreResult<List<Breadcrumb>>>
internal expect suspend fun platformAddBreadcrumb(sessionId: String, crumb: Breadcrumb): WriteResult<String>
internal expect suspend fun platformGetBreadcrumbs(sessionId: String): WriteResult<List<Breadcrumb>>
internal expect suspend fun platformSaveSessionGpsSummary(sessionId: String, summary: GpsSummary): WriteResult<Unit>

// `visitId` defaults to "" for back-compat: blank → legacy flat path
// families/{kinfolkId}/bookings/{bookingId}/{notes|internalNotes}; non-blank →
// nested envelope path families/{kinfolkId}/bookings/{bookingId}/kinCares/{visitId}/...
// (bookingId is treated as the batchId). The callable name is unchanged; the
// payload carries batchId + visitId when present (server resolves legacy bookingId).
internal expect fun platformBookingNotesStream(kinfolkId: String, bookingId: String, internal: Boolean, visitId: String = ""): Flow<FirestoreResult<List<BookingNote>>>
internal expect suspend fun platformAddBookingNote(kinfolkId: String, bookingId: String, body: String, internal: Boolean, visitId: String = ""): WriteResult<String>

// KinTale comment thread. kinfolkId is required by the jvm getKinTaleComments callable read;
// web/android direct-read ignore it (admin snapshot listener on the comments subcollection).
internal expect fun platformKinTaleCommentsStream(taleId: String, kinfolkId: String): Flow<FirestoreResult<List<KinTaleComment>>>
internal expect suspend fun platformAddKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?): WriteResult<String>

/**
 * Generic v2 onCall Firebase Function invoker. `payloadJson` is the request body
 * as a JSON object string. On success, [WriteResult.Ok.value] carries the raw
 * JSON string of the response `data` field - caller decodes.
 *
 * wasmJs: routes through `window.__fb.callFunction`. jvm: stub error until the
 * REST/admin-SDK shim is wired.
 */
internal expect suspend fun platformInvokeCallable(name: String, payloadJson: String): WriteResult<String>

private val importedCountJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Decode the `{"imported":N}` body of the syncGoogleCalendarBusyEvents callable.
 * Throws on malformed JSON so the caller maps it to WriteResult.Err; a valid
 * body that omits `imported` decodes to 0 (no fabricated count).
 */
internal fun decodeImportedCount(dataJson: String): Int =
    importedCountJson.parseToJsonElement(dataJson).jsonObject["imported"]?.jsonPrimitive?.intOrNull ?: 0

/**
 * Outcome of the `batchUpdateBookings` admin callable: how many visits moved to
 * the target status and the per-id failures (each with the server's error).
 */
data class BatchBookingResult(
    val action: String,
    val updated: Int,
    val failed: List<BatchBookingFailure>,
) {
    val failedCount: Int get() = failed.size
}

data class BatchBookingFailure(val id: String, val error: String)

/**
 * Pure decode of the batchUpdateBookings body
 * `{ok, action, updated, failed:[{id,error}]}`. Missing fields decode to safe
 * empties (no fabricated counts). Throws on malformed JSON so the caller maps to
 * WriteResult.Err.
 */
internal fun decodeBatchBookingResult(dataJson: String): BatchBookingResult {
    val obj = importedCountJson.parseToJsonElement(dataJson).jsonObject
    val action = obj["action"]?.jsonPrimitive?.contentOrNull ?: ""
    val updated = obj["updated"]?.jsonPrimitive?.intOrNull ?: 0
    val failed = (obj["failed"] as? JsonArray).orEmpty().mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        BatchBookingFailure(
            id = o["id"]?.jsonPrimitive?.contentOrNull ?: "",
            error = o["error"]?.jsonPrimitive?.contentOrNull ?: "",
        )
    }
    return BatchBookingResult(action = action, updated = updated, failed = failed)
}

/**
 * Pure decode of the listCatalogKeys body `{keys:[...]}`. Throws on malformed
 * JSON; an omitted/empty `keys` decodes to an empty list.
 */
internal fun decodeCatalogKeys(dataJson: String): List<String> =
    (importedCountJson.parseToJsonElement(dataJson).jsonObject["keys"] as? JsonArray)
        .orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }

/** Run-4 #6: dog + cat breed name lists from the `getBreeds` callable. */
data class BreedLists(
    val dogBreeds: List<String> = emptyList(),
    val catBreeds: List<String> = emptyList(),
)

/**
 * Pure decode of the getBreeds body `{dogBreeds:[...], catBreeds:[...]}`. Throws on
 * malformed JSON so the caller maps to WriteResult.Err; an omitted/empty array
 * decodes to an empty list (no fabricated breeds).
 */
internal fun decodeBreedLists(dataJson: String): BreedLists {
    val obj = importedCountJson.parseToJsonElement(dataJson).jsonObject
    fun arr(key: String): List<String> =
        (obj[key] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }
    return BreedLists(dogBreeds = arr("dogBreeds"), catBreeds = arr("catBreeds"))
}

/**
 * One staff member from the listStaff callable, for the Assigned Auntie picker.
 * displayName / email are nullable server-side (a staff doc may carry neither).
 */
data class StaffMember(
    val uid: String,
    val displayName: String? = null,
    val email: String? = null,
) {
    /** What the picker row shows: name, else email, else the uid. */
    val pickerLabel: String get() = displayName ?: email ?: uid
}

/**
 * Pure decode of the listStaff body `{staff:[{uid, displayName, email}]}`.
 * Lenient: entries without a uid are dropped (a row we can't assign is
 * useless), missing/null name + email decode as null, and an omitted `staff`
 * array decodes to an empty list. Throws on malformed JSON so the caller maps
 * to WriteResult.Err.
 */
internal fun decodeStaffList(dataJson: String): List<StaffMember> =
    (importedCountJson.parseToJsonElement(dataJson).jsonObject["staff"] as? JsonArray)
        .orEmpty().mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val uid = o["uid"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
                ?: return@mapNotNull null
            StaffMember(
                uid = uid,
                displayName = o["displayName"]?.jsonPrimitive?.contentOrNull,
                email = o["email"]?.jsonPrimitive?.contentOrNull,
            )
        }

/**
 * Pure decode of the `{"archived":N}` body returned by archiveNotification /
 * bulkArchiveNotifications. Throws on malformed JSON so the caller maps to
 * WriteResult.Err; a valid body that omits `archived` decodes to 0.
 */
internal fun decodeArchivedCount(dataJson: String): Int =
    importedCountJson.parseToJsonElement(dataJson).jsonObject["archived"]?.jsonPrimitive?.intOrNull ?: 0

// ── Home dashboard widgets fan-out models + decoders (AO-35/39/40/41) ──────────
//
// Plain models decoded from the new admin callables, imported by the pure-logic
// layer (screens/home/DashboardInsights.kt) so every rule is JVM-unit-testable and
// the callable is the single source of truth. JSON numbers may arrive as ints or
// doubles (firebase-bridge stringifies res.data), so numeric reads fall back
// through doubleOrNull. All throw on malformed JSON so the caller maps to
// WriteResult.Err (fail loud, never fake).

private fun JsonObject.intField(key: String): Int =
    this[key]?.jsonPrimitive?.let { it.intOrNull ?: it.doubleOrNull?.toInt() } ?: 0

private fun JsonObject.doubleField(key: String): Double =
    this[key]?.jsonPrimitive?.doubleOrNull ?: 0.0

private fun JsonObject.strField(key: String): String =
    this[key]?.jsonPrimitive?.contentOrNull ?: ""

/** AO-35 Route Optimizer: one optimized stop on the day's route. */
data class RouteStop(
    val order: Int,
    val sessionId: String,
    val kinfolkId: String,
    val household: String,
    val address: String,
    val arrivalEta: String,   // HH:MM
)

/** AO-35: a visit that could not be routed (fail-loud, e.g. no service address). */
data class RouteUnroutable(
    val sessionId: String,
    val household: String,
    val reason: String,
)

/** AO-35: the whole optimizeRoute result. */
data class RouteResult(
    val stops: List<RouteStop>,
    val totalMiles: Double,
    val totalMinutes: Int,
    val unroutable: List<RouteUnroutable>,
)

/**
 * Pure decode of the optimizeRoute body
 * `{stops:[{order,sessionId,kinfolkId,household,address,arrivalEta}], totalMiles,
 * totalMinutes, unroutable:[{sessionId,household,reason}]}`. Throws on malformed
 * JSON. Missing arrays decode to empty (no fabricated stops).
 */
internal fun decodeRouteResult(dataJson: String): RouteResult {
    val o = importedCountJson.parseToJsonElement(dataJson).jsonObject
    val stops = (o["stops"] as? JsonArray).orEmpty().mapNotNull { el ->
        val s = el as? JsonObject ?: return@mapNotNull null
        RouteStop(
            order = s.intField("order"),
            sessionId = s.strField("sessionId"),
            kinfolkId = s.strField("kinfolkId"),
            household = s.strField("household"),
            address = s.strField("address"),
            arrivalEta = s.strField("arrivalEta"),
        )
    }
    val unroutable = (o["unroutable"] as? JsonArray).orEmpty().mapNotNull { el ->
        val u = el as? JsonObject ?: return@mapNotNull null
        RouteUnroutable(
            sessionId = u.strField("sessionId"),
            household = u.strField("household"),
            reason = u.strField("reason"),
        )
    }
    return RouteResult(
        stops = stops,
        totalMiles = o.doubleField("totalMiles"),
        totalMinutes = o.intField("totalMinutes"),
        unroutable = unroutable,
    )
}

/** AO-40 Expense Quick-Log: one recorded expense. */
data class ExpenseItem(
    val _id: String,
    val kind: String,        // gas | parking | supplies | other
    val amountCents: Int,
    val note: String,
    val occurredAt: String,  // ISO
)

/** AO-40: the listExpenses result (rows + server-computed rolling totals). */
data class ExpenseSummary(
    val expenses: List<ExpenseItem>,
    val weekTotalCents: Int,
    val monthTotalCents: Int,
)

/**
 * Pure decode of the listExpenses body
 * `{expenses:[{_id,kind,amountCents,note,occurredAt}], weekTotalCents,
 * monthTotalCents}`. Throws on malformed JSON; missing rows decode to empty.
 */
internal fun decodeExpenseSummary(dataJson: String): ExpenseSummary {
    val o = importedCountJson.parseToJsonElement(dataJson).jsonObject
    val rows = (o["expenses"] as? JsonArray).orEmpty().mapNotNull { el ->
        val e = el as? JsonObject ?: return@mapNotNull null
        val id = e["_id"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        ExpenseItem(
            _id = id,
            kind = e.strField("kind"),
            amountCents = e.intField("amountCents"),
            note = e.strField("note"),
            occurredAt = e.strField("occurredAt"),
        )
    }
    return ExpenseSummary(
        expenses = rows,
        weekTotalCents = o.intField("weekTotalCents"),
        monthTotalCents = o.intField("monthTotalCents"),
    )
}

/** AO-41 Supplies Tracker: one tracked supply line. */
data class SupplyItem(
    val _id: String,
    val name: String,
    val onHand: Int,
    val par: Int,          // reorder threshold
    val unit: String,
)

/** AO-41: the listSupplies result (rows + server-computed low count). */
data class SupplySummary(
    val supplies: List<SupplyItem>,
    val lowCount: Int,
)

/**
 * Pure decode of the listSupplies body
 * `{supplies:[{_id,name,onHand,par,unit}], lowCount}`. Throws on malformed JSON;
 * missing rows decode to empty.
 */
internal fun decodeSupplySummary(dataJson: String): SupplySummary {
    val o = importedCountJson.parseToJsonElement(dataJson).jsonObject
    val rows = (o["supplies"] as? JsonArray).orEmpty().mapNotNull { el ->
        val s = el as? JsonObject ?: return@mapNotNull null
        val id = s["_id"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        SupplyItem(
            _id = id,
            name = s.strField("name"),
            onHand = s.intField("onHand"),
            par = s.intField("par"),
            unit = s.strField("unit"),
        )
    }
    return SupplySummary(supplies = rows, lowCount = o.intField("lowCount"))
}

/** AO-39 Expiration Countdown: one expiration reminder. */
data class ExpirationItem(
    val _id: String,
    val label: String,
    val dateIso: String,     // YYYY-MM-DD
    val kinfolkId: String,
    val kind: String,        // gateCode | vetRecord | card | license | other
)

/**
 * Pure decode of the listExpirations body
 * `{expirations:[{_id,label,dateIso,kinfolkId,kind}]}`. Throws on malformed JSON;
 * a missing array decodes to empty. Server sorts by dateIso asc.
 */
internal fun decodeExpirations(dataJson: String): List<ExpirationItem> =
    (importedCountJson.parseToJsonElement(dataJson).jsonObject["expirations"] as? JsonArray)
        .orEmpty().mapNotNull { el ->
            val e = el as? JsonObject ?: return@mapNotNull null
            val id = e["_id"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            ExpirationItem(
                _id = id,
                label = e.strField("label"),
                dateIso = e.strField("dateIso"),
                kinfolkId = e.strField("kinfolkId"),
                kind = e.strField("kind"),
            )
        }

/**
 * Pure compute: given the full set of catalog keys and the set already bound to
 * templates, return the unbound keys (present in catalog, not yet bound), sorted
 * and de-duplicated. Case-sensitive (catalog keys are canonical ids).
 */
fun computeUnboundCatalogKeys(allCatalogKeys: List<String>, boundKeys: Set<String>): List<String> =
    allCatalogKeys.toSet().filter { it !in boundKeys }.sorted()

/** Pure compute: one-line summary of a batch result for fail-loud display. */
fun summarizeBatchResult(result: BatchBookingResult): String =
    if (result.failedCount == 0) "${result.updated} updated"
    else "${result.updated} updated, ${result.failedCount} failed"

/**
 * Verdict from the `verifyActivityLogChain` admin callable. [ok] true means the
 * SHA-256 chain validated end to end; [anomalyCode] (e.g. "seq_gap",
 * "prev_hash_mismatch", "entry_hash_mismatch", "head_mismatch") names the first
 * break when [ok] is false. [unchainedCount] is legacy/admin-SDK entries that
 * predate the chain and carry no `seq`.
 */
data class ChainVerifyResult(
    val ok: Boolean,
    val scanned: Int,
    val firstSeq: Int?,
    val lastSeq: Int?,
    val unchainedCount: Int,
    val anomalyCode: String?,
    val anomalySeq: Int? = null,
    val expectedEntryHash: String? = null,
    val actualEntryHash: String? = null,
)

/**
 * Result from the `recap_recent_comms` admin callable (Phase 1 Communicate
 * recipient intel). [recap] is the AI-generated one-to-two sentence summary
 * of recent communications; [lastAt] is the ISO-8601 timestamp of the most
 * recent source message; [sourceCount] is how many messages were sampled.
 */
data class CommsRecap(
    val recap: String,
    val lastAt: String,
    val sourceCount: Int,
)

// ---------- Models ----------
// Field names mirror what the AuntieOS Android app writes to Firestore
// (see android/.../data/model/Models.kt). _id is the Firestore document id.

@Serializable
data class Kinfolk(
    val _id: String = "",
    val firstName: String = "",
    val lastName:  String = "",
    val phoneNumber: String = "",
    val email: String = "",
    val profilePictureUrl: String = "",
    val status: String = "active",
    val outstandingBalance: String = "0.00",
    val tags: List<String> = emptyList(),

    // Contact & Identity
    val secondaryPhone: String = "",
    val secondaryEmail: String = "",
    val preferredContactMethod: String = "Text",
    val bestTimeToContact: String = "",

    // Home & Access
    val serviceAddress: String = "",
    val gateCode: String = "",
    val parkingInstructions: String = "",
    val entryNotes: String = "",
    val wifiName: String = "",
    val wifiPassword: String = "",

    // Emergency Contacts
    val emergencyContactName: String = "",
    val emergencyContactPhone: String = "",
    val emergencyContactRelation: String = "",

    // Household-level Vet Clinic (lives on Kinfolk, not Kin)
    val vetClinicName: String = "",
    val vetClinicPhone: String = "",
    val vetClinicAddress: String = "",

    // Admin & Relationship
    val internalNotes: String = "",
    val referralSource: String = "",
    val joinDate: String = "",

    /**
     * Time-bounded override on [preferredContactMethod] set by the comms reconcile
     * pipeline. When non-null and the current time is within
     * [ContactOverride.effectiveFrom..effectiveUntil], notification + compose UI
     * MUST prefer [ContactOverride.channel] over [preferredContactMethod].
     */
    val contactOverride: ContactOverride? = null,

    // Phase 14: answers to admin-authored form_schemas placed on KINFOLK
    // (appliesTo == "KINFOLK"), keyed by field id. Mirrors Kin.formValues.
    val formValues: Map<String, String> = emptyMap(),
) {
    val displayName: String
        get() = "$firstName $lastName".trim().ifBlank { "Unnamed Kinfolk" }
}

@Serializable
data class ContactOverride(
    val channel: String = "",            // text, email, phone, none
    val effectiveFrom: String = "",      // ISO-8601
    val effectiveUntil: String = "",     // ISO-8601, blank = open-ended
    val note: String = "",               // free-text reason
    val sourceLogType: String = "",      // sms | email | voicemail | call
    val sourceLogId: String = "",
    val setAt: String = "",
)

/**
 * Kin care session - the unit of work for a visit. Sessions move through a status
 * lifecycle (SCHEDULED → ON_MY_WAY → ARRIVED → DEPARTED → COMPLETED) and the GPS
 * route + KinTales (visit reports) attach to the session for the kinfolk's eyes.
 *
 * Field shape mirrors `data/model/Models.kt#KinCareSession` on the Android side
 * so the same `kin_care_sessions` documents deserialize cleanly here.
 */
@Serializable
/** AO-25: one visit in a multi-date/recurring request. [startTimeMs] is epoch ms
 *  from the operator's LOCAL wall-clock pick. [serviceId] optional (server resolves). */
data class NewBookingVisitInput(
    val startTimeMs: Long,
    val serviceName: String,
    val endTimeMs: Long? = null,
    val serviceId: String? = null,
)

/** AO-25: createMultiDateBookingRequest result (created envelope + its visits). */
data class MultiDateBookingResult(
    val batchId: String,
    val visitCount: Int,
    val visitIds: List<String>,
)

data class KinCareSession(
    val _id: String = "",
    val kinId: String = "",
    val kinfolkId: String = "",
    val kinIds: List<String> = emptyList(),
    val kinfolkName: String = "",
    val sourceBookingId: String = "",
    val invoiceId: String = "",            // FK -> invoices/{id} when session is attributed to an invoice
    val startTime: String = "",
    val endTime: String = "",
    val serviceType: String = "",
    val serviceDurationMinutes: Int = 0,
    val notes: String = "",
    val kinfolkNotes: String = "",
    val status: String = "SCHEDULED",
    val onMyWayAt: String = "",
    val arrivedAt: String = "",
    val departedAt: String = "",
    val completedAt: String = "",
    val visitRouteId: String = "",
    // Finalised GPS route + stats baked onto the session when DEPARTED fires
    // (buildGpsSummary in Auntie Time). Mirrors android KinCareSession.gpsSummary
    // so the SENT KinTale report + composer can render real Distance/Duration
    // without re-reading the breadcrumb subcollection. Null when GPS never ran.
    val gpsSummary: GpsSummary? = null,
    val etaMinutesAway: Int = 0,
    val reportIds: List<String> = emptyList(),
    val sentReportCount: Int = 0,
    val autoCompleteEligible: Boolean = false,
    val createdAt: String = "",
    val updatedAt: String = "",

    // Phase 14: answers to admin-authored form_schemas. A booking-create field
    // (appliesTo == "BOOKING") and a visit-day field (appliesTo == "SESSION") both
    // persist into this one map on the kin_care_sessions doc, keyed by field id;
    // each render context filters its own schemas by appliesTo. Mirrors Kin.formValues.
    val formValues: Map<String, String> = emptyMap(),

    // NOTE-53: MyTribe booking-envelope IDs. When a session originates from an
    // incoming MyTribe kinCare request these locate the originating doc at
    //   families/{kinfolkId}/bookings/{kinCareBatchId}/kinCares/{kinCareVisitId}
    // so that dispatchVisitNotification can route via the server-preferred
    // batchId+visitId pair instead of the legacy sourceBookingId. Mirrors
    // android data/model/Models.kt#KinCareSession.kinCareBatchId / kinCareVisitId.
    val kinCareBatchId: String? = null,   // -> families/{kinfolkId}/bookings/{batchId}
    val kinCareVisitId: String? = null,   // -> .../kinCares/{visitId}
)

@Serializable
data class GeneratedDraft(
    val _id: String = "",
    val status: String = "pending",
    val generatedCopy: String = "",
    val communicationType: String = "",
    val kinfolkId: String = "",
    val kinfolkName: String = "",
    val createdOn: String = "",
    val approvedAt: String = "",
)

/**
 * KinCareReport - the "KinTale" visit recap that goes home to a kinfolk after a
 * session. One session can have many reports (multi-day visits, midway updates).
 *
 * The Android model carries a `fieldResponses: Map<String, FieldResponse>` for
 * dynamic-template answers; we omit it here because the list view doesn't need
 * it and `ignoreUnknownKeys` will drop it cleanly. Add it back when the detail
 * view lands.
 */
@Serializable
data class KinCareReport(
    val _id: String = "",
    val sessionId: String = "",
    val kinfolkId: String = "",
    val kinfolkName: String = "",
    val authorId: String = "",
    val authorDisplayName: String = "",
    val kinIds: List<String> = emptyList(),
    val serviceType: String = "",
    val visitDate: String = "",
    val arrivedAt: String = "",
    val departedAt: String = "",
    val visitRouteId: String = "",
    val templateId: String = "",
    val title: String = "",
    val bodyCopy: String = "",
    val fieldResponses: Map<String, FieldResponse> = emptyMap(),
    val petMoodSelections: Map<String, String> = emptyMap(),
    val mediaFileIds: List<String> = emptyList(),
    val status: String = "DRAFT",
    val sentAt: String = "",
    val sentVia: String = "",
    val deliveryReceiptId: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",

    // ---- Orphan-triage fields (May-17 migration backfill UI) ----
    // Empty `triageStatus` means "not yet triaged". After admin action, set to
    // one of: "assigned" | "duplicate" | "archived_bad_data". The companion fields
    // (triagedAt/triagedBy/duplicateOfReportId/archiveReason) carry the audit
    // info. Shape mirrors the Android sibling so a single Firestore doc
    // round-trips on both platforms.
    val triageStatus: String = "",
    val triagedAt: String = "",
    val triagedBy: String = "",
    val duplicateOfReportId: String = "",
    val archiveReason: String = "",

    // Phase 14: answers to admin-authored form_schemas placed on KINTALE
    // (appliesTo == "KINTALE"), keyed by field id. DISTINCT from [fieldResponses]
    // (which are KinTale-template answers): formValues are admin-defined custom
    // schema fields, fieldResponses are the report template's structured fields.
    val formValues: Map<String, String> = emptyMap(),
)

/**
 * True when this report is a migration-orphan that still needs admin attention:
 * no kinfolk linked, no triage decision yet, and `sentVia` matches one of the
 * pass-1 ("legacy_orphan") or pass-2 ("legacy_visit_logs") backfill markers
 * the May-17 migration scripts wrote.
 */
fun KinCareReport.isUntriagedOrphan(): Boolean =
    kinfolkId.isBlank() && triageStatus.isBlank() &&
    sentVia in setOf("legacy_orphan", "legacy_visit_logs")

// --- Comms log models - one per channel, all written to Firestore by the
// inbound pipeline and consumed by the four log screens. Field shape mirrors
// `data/model/Models.kt` on the Android side.

@Serializable
data class VoicemailLog(
    val _id: String = "",
    val kinfolkId: String? = null,
    val kinfolkName: String = "",
    val callerNumber: String = "",
    val transcript: String = "",
    val audioUrl: String = "",
    val durationSec: Int = 0,
    val direction: String = "inbound",
    val timestamp: String = "",
    val twilioCallSid: String = "",

    val replyStatus: String = "unread",       // unread | read | replied | dismissed
    val repliedAt: String = "",
    val replyLogId: String = "",

    val reconcileStatus: String = "pending",  // pending | applied | skipped | failed
    val reconciledAt: String = "",
    val reconcileNotes: String = "",
)

@Serializable
data class CallLog(
    val _id: String = "",
    val kinfolkId: String? = null,
    val kinfolkName: String = "",
    val counterpartNumber: String = "",
    val direction: String = "inbound",        // inbound | outbound
    val status: String = "",                  // answered | missed | declined | voicemail
    val transcript: String = "",
    val recordingUrl: String = "",
    val durationSec: Int = 0,
    val timestamp: String = "",
    val twilioCallSid: String = "",
    val voicemailLogId: String = "",

    val reconcileStatus: String = "pending",
    val reconciledAt: String = "",
    val reconcileNotes: String = "",
)

@Serializable
data class SmsMessage(
    val _id: String = "",
    val kinfolkId: String? = null,
    val kinfolkName: String = "",
    val counterpartNumber: String = "",
    val direction: String = "inbound",
    val subType: String = "sms",              // sms | mms | rcs
    val body: String = "",
    val mediaUrls: List<String> = emptyList(),
    val threadId: String = "",
    val timestamp: String = "",
    val twilioMessageSid: String = "",
    val status: String = "",

    val reconcileStatus: String = "pending",
    val reconciledAt: String = "",
    val reconcileNotes: String = "",
)

@Serializable
data class EmailMessage(
    val _id: String = "",
    val kinfolkId: String? = null,
    val kinfolkName: String = "",
    val fromAddress: String = "",
    val toAddresses: List<String> = emptyList(),
    val ccAddresses: List<String> = emptyList(),
    val subject: String = "",
    val body: String = "",
    val bodyHtml: String = "",
    val attachmentUrls: List<String> = emptyList(),
    val threadId: String = "",
    val direction: String = "inbound",
    val timestamp: String = "",
    val providerMessageId: String = "",
    val status: String = "",

    val reconcileStatus: String = "pending",
    val reconciledAt: String = "",
    val reconcileNotes: String = "",
)

@Serializable
data class Kin(
    val _id: String = "",
    val kinfolkId: String = "",
    val name: String = "",
    val species: String = "Dog",
    val breed: String = "",
    val age: String = "",
    val sex: String = "",
    val weight: String = "",
    val status: String = "active",
    val profilePictureUrl: String = "",   // Kin (pet) photo; parity with android Kin.profilePictureUrl

    // Extended care fields (mirror Android model)
    val colorMarkings: String = "",
    val spayedNeutered: Boolean = false,
    val staysAs: String = "",
    val routine: String = "",
    val trainingCommands: String = "",
    val feedingBrand: String = "",
    val vaccinations: String = "",
    val medicationHealthNotes: String = "",
    val vetInfo: String = "",
    val checklist: String = "",
    val reactive: Boolean = false,
    val ownerEmail: String = "",
    val ownerPhone: String = "",
    val officeNotes: String = "",
    // Structured per-kin values for dynamic KIN form_schemas (appliesTo=KIN), e.g.
    // the precare checklist (spec 06 item 5 / 1C). Keyed by FormFieldSpec.key.
    // Supersedes the free-text [checklist] blob, which is kept read-only (no data loss).
    val formValues: Map<String, String> = emptyMap(),
)

/**
 * Firestore collection: invoices. Mirrors the Android `Invoice` model.
 * Money fields are doubles in the source of truth; surface as currency in UI.
 */
@Serializable
data class Invoice(
    val _id: String = "",
    val kinfolkId: String = "",
    val kinfolkName: String = "",
    val invoiceNumber: String = "",
    val client: String = "",
    val address: String = "",
    val date: String = "",
    val terms: String = "",
    val dueDate: String = "",
    val discount: String = "",
    val total: Double = 0.0,
    val paymentsHistory: String = "",
    val amountDue: Double = 0.0,
    val status: String = "",         // free-text on Android; UI groups by paid vs outstanding via amountDue
    val viewed: String = "",
    // Attribution fields written by backfill_structural_links.py
    val sessionIds: List<String> = emptyList(),
    @SerialName("_attribution") val attribution: String = "",
    @SerialName("_attributionAt") val attributionAt: String = "",
)

/**
 * Firestore collection: dossiers - one document per kinfolk, indexed by
 * `kinfolkId`. Holds the narrative + structured profile facts that the
 * comms reconcile pipeline writes to. See [project_auntieos_architecture.md]
 * for the annotation conventions used inside [rawSummary].
 */
@Serializable
data class Dossier(
    val _id: String = "",
    val kinfolkId: String = "",
    val communicationStyle: String = "",
    val householdNotes: String = "",
    val relationshipWithAuntie: String = "",
    val importantLifeContext: String = "",
    val preferredContactMethod: String = "",
    val rawSummary: String = "",
    val tldr: String = "",
    val lastReconciledAt: String = "",
    val lastReconcileSourceLogIds: List<String> = emptyList(),
    val needsMoreSamples: Boolean = false,
)

/**
 * Firestore collection: household_data - one document per Kinfolk household.
 * Mirrors Android `HouseholdData` shape exactly so a single Firestore doc
 * renders on either platform. Per-pet data lives on [Kin411]; this is
 * household-shared info (vet contacts, item locations, routines, emergency
 * plans, service providers).
 */
@Serializable
data class HouseholdData(
    val _id: String = "",
    val kinfolkId: String = "",

    // Veterinary Information
    val primaryVetName: String = "",
    val primaryVetPhone: String = "",
    val primaryVetAddress: String = "",
    val primaryVetHours: String = "",
    val emergencyVetName: String = "",
    val emergencyVetPhone: String = "",
    val emergencyVetAddress: String = "",

    // Household Items & Locations
    val foodLocation: String = "",
    val treatLocation: String = "",
    val medicationLocation: String = "",
    val toysLocation: String = "",
    val beddingLocation: String = "",
    val leashesPoopBagsLocation: String = "",
    val cleaningSuppliesLocation: String = "",

    // Routines & Preferences
    val householdRules: String = "",
    val preferredWalkRoutes: String = "",
    val neighborhoodHazards: String = "",
    val securitySystemInfo: String = "",
    val thermostatInstructions: String = "",
    val lightingPreferences: String = "",

    // Emergency & Safety
    val poisonControlNumber: String = "",
    val emergencyContactsPriority: String = "",
    val evacuationPlan: String = "",
    val importantDocumentsLocation: String = "",

    // Service Providers
    val groomerName: String = "",
    val groomerPhone: String = "",
    val trainerName: String = "",
    val trainerPhone: String = "",
    val petSitterBackup: String = "",
    val dogWalkerBackup: String = "",

    val createdAt: String = "",
    val updatedAt: String = "",
)

/**
 * Firestore collection: the_411 - one document per kin, indexed by `kinId`. Same
 * narrative + structured care info pattern as [Dossier], scoped to the kin.
 */
@Serializable
data class Kin411(
    val _id: String = "",
    val kinId: String = "",
    val breed: String = "",
    val personality: String = "",
    val quirksAndPreferences: String = "",
    val medicalNotes: String = "",
    val dietaryDetails: String = "",
    val rawSummary: String = "",
    val tldr: String = "",
    val vetName: String = "",
    val vetPhone: String = "",
    val feedingAmount: String = "",
    val feedingFrequency: String = "",
    val pottyRoutine: String = "",
    val reactive: Boolean = false,
    val lastReconciledAt: String = "",
    val lastReconcileSourceLogIds: List<String> = emptyList(),
    val needsMoreSamples: Boolean = false,
)

/**
 * Firestore collection: activity_log. Mirrors the Android `ActivityLogEntry` so both
 * platforms read the same collection as a single source of truth; audit hooks
 * elsewhere write events to it.
 */
@Serializable
data class ActivityLogEntry(
    val _id: String = "",
    val timestamp: String = "",      // ISO-8601
    val actionType: String = "",     // LOGIN | CREATE_BOOKING | UPDATE_SETTINGS | …
    val description: String = "",
    val status: String = "",         // SUCCESS | FAILURE | PENDING
    val actorId: String = "",        // user/auth uid that triggered the event
    val targetId: String = "",       // optional doc id the action applied to
    val targetCollection: String = "",
    // Hash-chain seal (written by writeAuditEntry). Legacy/admin-SDK entries that
    // predate the chain have no seq and carry blank hashes.
    val seq: Int? = null,
    val prevHash: String = "",
    val entryHash: String = "",
)

/**
 * Firestore collection: `notifications`. Catalog-dispatched notifications
 * written by MyTribe functions notification subsystem. Each doc has a recipient
 * uid + per-channel sub-docs. Web admin reads to display the operator's own
 * inbox of business-side notifications (booking confirmations, lockouts, etc.).
 */
@Serializable
data class NotificationEntry(
    val _id: String = "",
    val key: String = "",            // catalog key, e.g. 'kincare.booking.confirm'
    val category: String = "",
    val recipientUid: String = "",
    val actorUid: String? = null,
    val status: String = "",         // pending | dispatched
    val mode: String = "",           // trigger | debounced | batched | scheduled
    val channels: List<String> = emptyList(),
    // ISO-8601. Written as a server Timestamp; the serializer normalizes the
    // bridge's {seconds,nanoseconds} object to ISO on decode (AUNTIEOS-ADMIN-13).
    @Serializable(with = FirestoreInstantStringSerializer::class)
    val createdAt: String = "",
    // Stamped by markNotificationRead / bulkMarkNotificationsRead. Blank == unread.
    @Serializable(with = FirestoreInstantStringSerializer::class)
    val readAt: String = "",
    // Stage 2 Step 4: linkage to the item this notification is about, written by
    // the dispatcher. targetType is one of '' | 'booking' | 'invoice' | 'kintale'
    // | 'kinfolk'; targetId is the doc id of that item. Drives the "open linked
    // item" quick-action + the booking-only approve/deny actions.
    val targetType: String = "",
    val targetId: String = "",
    // Stamped by archiveNotification / bulkArchiveNotifications (server timestamp).
    // Blank == in the active inbox; non-blank == archived (filtered out by default).
    @Serializable(with = FirestoreInstantStringSerializer::class)
    val archivedAt: String = "",
) {
    /** True once the recipient (or an admin) has marked this notification read. */
    val isRead: Boolean get() = readAt.isNotBlank()

    /** True once this notification has been archived out of the active inbox. */
    val isArchived: Boolean get() = archivedAt.isNotBlank()
}

/**
 * Firestore collection: payments. Mirrors the Android `Payment` model exactly.
 * Money fields (amount, tip) are doubles. Firestore document id lives in `_id`.
 */
@Serializable
data class Payment(
    val _id: String = "",
    val kinfolkId: String = "",
    val kinfolkName: String = "",
    val client: String = "",
    val address: String = "",
    val date: String = "",
    val paymentMethod: String = "",
    val referenceNumber: String = "",
    val email: String = "",
    val tip: Double = 0.0,
    val amount: Double = 0.0,
    val notes: String = "",
    // Confident payment->invoice link (kinfolkId + payment-date match); written by
    // match_payments_to_invoices.py. Blank when no confident single-invoice match exists.
    val invoiceId: String = "",
    val invoiceNumber: String = "",
)

/**
 * Firestore collection: `booking_time_slots`. A single availability/block window
 * on a given day. The deployed `syncGoogleCalendarBusyEvents` Cloud Function writes
 * BLOCKED slots here from the auntie's Google Calendar busy ranges
 * (`isAvailable=false`, `slotType="BLOCKED"`, `source="GOOGLE_BUSY_IMPORT"`,
 * `hideDetailsFromKinfolk=true`). The Schedule grid draws the BLOCKED ones as
 * read-only "Busy" overlays. Field names below are the Firestore wire names,
 * byte-for-byte, mirroring the Android [BookingTimeSlot] model. The enum-typed
 * Android fields (slotType/source/syncState) are kept as plain strings here so an
 * unexpected server value can never throw during deserialization; we only ever
 * filter on [isAvailable], which is the canonical BLOCKED signal.
 */
@Serializable
data class BookingTimeSlot(
    val _id: String = "",
    val date: String = "",       // YYYY-MM-DD
    val startTime: String = "",  // HH:mm
    val endTime: String = "",    // HH:mm
    val isAvailable: Boolean = true,
    val slotType: String = "AVAILABLE",
    val notes: String = "",
    val createdAt: String = "",
    val source: String = "INTERNAL_MANUAL",
    val externalEventId: String? = null,
    val externalCalendarId: String? = null,
    val hideDetailsFromKinfolk: Boolean = true,
    val isEditableByAdmin: Boolean = true,
    val isRemovableByAdmin: Boolean = true,
    val syncState: String = "LOCAL_ONLY",
)

/**
 * Canonical Firestore document id for the unified settings doc. Both reads and
 * writes target `business_settings/{BUSINESS_SETTINGS_DOC_ID}` on every platform
 * (2026-06-05 unification). Never "singleton" or firstOrNull() of the collection.
 */
const val BUSINESS_SETTINGS_DOC_ID: String = "business_settings"

/**
 * Firestore collection: business_settings - single document
 * (`business_settings/business_settings`) holding Auntie's full settings.
 *
 * This is the CANONICAL unified schema (2026-06-05 settings unification): the
 * union of the legacy `business_settings` doc (GPS/tracking, eta/draft,
 * notifications, holiday lists, calendarSyncId, business profile) and the legacy
 * `admin_settings` doc (booking config, timeBlocks, timeZone). Both web and
 * android share this one model; reads/writes target the single doc id
 * `business_settings`, writes MERGE so no platform clobbers fields it does not
 * edit. Field names below are the Firestore wire names (byte-for-byte).
 */
@Serializable
data class BusinessSettings(
    val _id: String = "",

    // ---- Business profile ----
    val businessName: String = "",
    val businessEmail: String = "",
    val businessPhone: String = "",
    val businessAddress: String = "",
    val timeZone: String = "America/New_York",
    val serviceRates: Map<String, String> = emptyMap(),
    // Business hours: day → "HH:MM-HH:MM" or "" (closed)
    val businessHours: Map<String, String> = emptyMap(),

    // ---- Payment options (operator-entered handles printed on invoices) ----
    val venmoHandle: String = "",
    val paypalHandle: String = "",
    val cashappHandle: String = "",

    // ---- Weather (W16/W17) ----
    // Service-AREA place name (city / metro / ZIP) the Home weather widgets forecast for.
    // Deliberately NOT the street address — the operator picks their coverage area (e.g.
    // "Austin, TX"). Blank → widgets show a fail-loud "set your weather area" prompt.
    val weatherLocation: String = "",

    // ---- Notifications ----
    // Legacy coarse channel toggles. The per-notification gate matrix
    // (getBusinessNotificationOverrides) is the source of truth now; these stay for
    // back-compat with existing docs and serialization round-trips.
    val notificationEmail: Boolean = true,
    val notificationSms: Boolean = true,
    val notificationPush: Boolean = true,

    // ---- Time off / holidays ----
    // List of US holiday IDs observed (e.g. "new_years", "thanksgiving")
    val observedUsHolidays: List<String> = emptyList(),
    // Company holidays: list of "YYYY-MM-DD|Name" entries
    val companyHolidays: List<String> = emptyList(),
    // Special hours: list of "YYYY-MM-DD|hours" entries
    val specialHours: List<String> = emptyList(),
    // Android master toggle, distinct from the observedUsHolidays list above.
    val observeUsHolidays: Boolean = false,

    // ---- Booking / scheduling config (migrated from admin_settings) ----
    val defaultBookingMode: String = "SPECIFIC_TIME",
    val defaultCalendarView: String = "MONTH",
    val allowTimeBlockBooking: Boolean = true,
    val allowSpecificTimeBooking: Boolean = true,
    val enableConflictDetection: Boolean = true,
    val enableAutoReminder24h: Boolean = false,
    val defaultTimeBlockDurationHours: Int = 4,
    val travelBufferMinutes: Int = 30,
    // Bookable time blocks (formerly admin_settings.timeBlocks). Drives the
    // §A.8 time-block resolver + "Evening block" descriptors on Auntie Time/Bookings.
    val timeBlocks: List<TimeBlockDefinition> = listOf(
        TimeBlockDefinition(
            id = "midday",
            label = "Midday",
            startTime = "11:00",
            endTime = "15:00",
            isActive = true,
        ),
    ),

    // ---- GPS / tracking ----
    val enableGPSTrackingForAllVisits: Boolean = true,
    val enablePhotoLocationTagging: Boolean = true,
    val requireArrivalDepartureVerification: Boolean = true,
    val autoStartTrackingOnVisitStart: Boolean = true,
    // Wire String: LOW | MEDIUM | HIGH (android keeps its enum, maps to/from these).
    val trackingAccuracy: String = "HIGH",
    val saveRoutesForDays: Int = 90,
    val allowClientLocationSharing: Boolean = true,

    // ---- Visit ETA / drafts ----
    val defaultEtaMinutes: Int = 15,
    val etaMinuteOptions: List<Int> = listOf(5, 10, 15, 20, 30, 45, 60),
    val draftRetentionDays: Int = 30,
    val draftRetentionOptions: List<Int> = listOf(30, 60, 90),

    // ---- Calendar ----
    // Google Calendar id the syncGoogleCalendarBusyEvents callable reads (admin
    // types it in Settings). When non-empty this wins over the GOOGLE_CALENDAR_ID
    // secret. Auth stays a service account the admin shares the calendar with; no
    // OAuth, no token stored here.
    val calendarSyncId: String = "",

    // ---- Booking behavior (#9, 2026-06-08) ----
    // Real persisted toggles (admin-writable; no callable). autoConfirmRepeatKinfolk
    // is consumed server-side by requestBooking (a repeat kinfolk's request is
    // confirmed immediately, skipping the Incoming-requests queue). snapRescheduleTo15Min
    // is a client behavior: the Schedule drag snaps the dropped time to quarter-hours.
    val autoConfirmRepeatKinfolk: Boolean = false,
    val snapRescheduleTo15Min: Boolean = false,

    // ---- Branding (17.2) ----
    // All blank by default; a blank field means "use the shipped value" so the
    // app reads byte-identical to pre-17.2 until the operator customizes it.
    // Persisted on the same business_settings doc via the existing merge write
    // (rule: write if isAuntie() - the sole operator - so no backend is needed).
    // Resolved for display by the pure helpers in branding/Branding.kt.
    val logoUrl: String = "",          // nav-rail brand mark image (Cloudinary URL); blank -> PawPrint glyph
    val brandWordmark: String = "",    // nav-rail wordmark; blank -> "AuntieOS"
    val brandTagline: String = "",     // nav-rail tagline; blank -> "Tribe Tails Care"
    val homeGreeting: String = "",     // Home heading salutation; blank -> time-aware greetingForHour()
    val homeAccentTail: String = "",   // Home heading accent word; blank -> "Auntie."

    // ---- MyTribe client-portal config (shared wire contract) ----
    // Drives the MyTribe kinfolk portal (chrome, home layout, banner, chat).
    // Default-constructed so a doc without `mytribePortal` deserializes unchanged
    // (back-compat). Persisted via the existing merge write (saveBusinessSettings).
    val mytribePortal: MyTribePortalConfig = MyTribePortalConfig(),

    // ---- Meta ----
    val updatedAt: String = "",
    val updatedBy: String = "",
)

/**
 * MyTribe client-portal configuration. Shared wire contract across AuntieOS
 * (this model), the getMyHome Function, and the MyTribe portal client — field
 * names/types/defaults MUST match byte-for-byte on all three sides.
 */
@Serializable
data class MyTribePortalConfig(
    val logoUrl: String = "",
    val themeId: String = "default",
    val banner: PortalBanner = PortalBanner(),
    val home: PortalHome = PortalHome(),
    val chat: PortalChat = PortalChat(),
)

@Serializable
data class PortalBanner(
    val enabled: Boolean = false,
    val message: String = "",
    val tone: String = "info",
    val dismissMode: String = "none",
    val id: String = "",
)

@Serializable
data class PortalHome(
    val sections: List<HomeSectionCfg> = emptyList(),
)

/** A single home section's config. `limit` 0 means unlimited. */
@Serializable
data class HomeSectionCfg(
    val id: String = "",
    val enabled: Boolean = true,
    val limit: Int = 0,
)

@Serializable
data class PortalChat(
    val enabled: Boolean = true,
    val awayMessage: String = "",
    val hoursEnabled: Boolean = false,
    val hours: Map<String, String> = emptyMap(),
    val maxMessageLength: Int = 2000,
    val rateLimitPerHour: Int = 0,
)

/**
 * A bookable time window. Mirrors android `TimeBlockDefinition` (ServiceModels.kt).
 * The wire key for [isActive] is `active` to match prod + android.
 */
@Serializable
data class TimeBlockDefinition(
    val id: String = "",
    val label: String = "",
    val startTime: String = "",   // "HH:mm"
    val endTime: String = "",     // "HH:mm"
    @SerialName("active") val isActive: Boolean = true,
)

@Serializable
data class TrainingDocument(
    val _id: String = "",
    val title: String = "",
    val content: String = "",
    val communicationType: String = "",
    val kinfolkRef: String = "",
    val uploadedAt: String = "",
    val notes: String = "",
    // Phase 12 / spec 23 Tribal Intel write fields. targetType is KINFOLK or KIN.
    val targetType: String = "",
    val targetKinfolkId: String = "",
    val targetKinId: String = "",
    val attachments: List<TrainingDocAttachment> = emptyList(),
    // Reconcile provenance surfaced back on the card so skipped/errored intel is visible.
    val reconcileStatus: String = "",
    val reconcileNotes: String = "",
)

/** One Cloudinary attachment on a Tribal Intel entry. */
@Serializable
data class TrainingDocAttachment(
    val storageUrl: String = "",
    val cloudinaryPublicId: String = "",
    val fileType: String = "",
    val mimeType: String = "",
    val fileName: String = "",
)

/**
 * Firestore subcollection: kin_care_sessions/{sessionId}/breadcrumbs. One
 * doc per GPS ping while a session is in flight (status ARRIVED..DEPARTED).
 * Used for both Uber-style live tracking (subscribe latest) and AllTrails-
 * style replay (orderBy timestamp, render polyline).
 */
@Serializable
data class Breadcrumb(
    val _id: String = "",
    val timestamp: String = "",   // ISO-8601, doubles as the natural sort key
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val accuracyMeters: Double = 0.0,
    val headingDegrees: Double = 0.0,    // 0..360, -1 if unknown
    val speedMetersPerSec: Double = 0.0, // -1 if unknown
)

/**
 * Finalised GPS summary for a completed session. Persisted on the parent
 * `kin_care_sessions/{sid}` doc when DEPARTED fires so MyTribe + the future
 * Departed-email flow can render route + stats without re-reading the
 * breadcrumb subcollection.
 */
@Serializable
data class GpsSummary(
    val distanceMeters: Double = 0.0,
    val durationSeconds: Long = 0L,
    val startLat: Double = 0.0,
    val startLng: Double = 0.0,
    val endLat: Double = 0.0,
    val endLng: Double = 0.0,
    /** Down-sampled polyline. Cap at 5_000 points to stay under Firestore's 1MB doc limit. */
    val route: List<GpsPoint> = emptyList(),
    val computedAt: String = "",
)

@Serializable
data class GpsPoint(
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    /** Epoch millis of this ping (0 if unknown). */
    val t: Long = 0L,
)

/**
 * Adapt a persisted [GpsSummary] into the [Breadcrumb] list the shared `RouteMap`
 * renders. RouteMap derives Distance from lat/lng and Duration from the breadcrumb
 * timestamps, so each [GpsPoint.t] (epoch millis) is rendered into the slim
 * ISO-8601 form RouteMap's parser understands. A point with `t == 0` (older
 * summaries that never captured a ping clock) maps to a blank timestamp, which
 * RouteMap treats as "duration unknown" (shows "-") rather than a fabricated value.
 * An empty route yields an empty list so the caller hides the map (fail-loud by
 * omission, never a faked 1.4 mi / 32 min).
 */
fun GpsSummary.toBreadcrumbs(): List<Breadcrumb> =
    route.map { p ->
        Breadcrumb(
            lat = p.lat,
            lng = p.lng,
            timestamp = if (p.t > 0L) epochMillisToIso(p.t) else "",
        )
    }

/**
 * Epoch-millis -> slim "YYYY-MM-DDTHH:MM:SSZ" UTC string. The inverse of the
 * parser in RouteMap.kt (`parseIsoMillis`), kept here so the GPS-summary adapter
 * can round-trip timestamps without pulling in a platform Date API. Uses Howard
 * Hinnant's civil-from-days algorithm.
 */
internal fun epochMillisToIso(ms: Long): String {
    val totalSeconds = ms / 1_000L
    val days = if (totalSeconds >= 0) totalSeconds / 86_400L else (totalSeconds - 86_399L) / 86_400L
    val secOfDay = (totalSeconds - days * 86_400L)
    val hh = (secOfDay / 3_600L).toInt()
    val mm = ((secOfDay % 3_600L) / 60L).toInt()
    val ss = (secOfDay % 60L).toInt()
    // civil-from-days (Howard Hinnant)
    val z = days + 719_468L
    val era = (if (z >= 0) z else z - 146_096L) / 146_097L
    val doe = z - era * 146_097L
    val yoe = (doe - doe / 1_460L + doe / 36_524L - doe / 146_096L) / 365L
    val y = yoe + era * 400L
    val doy = doe - (365L * yoe + yoe / 4L - yoe / 100L)
    val mp = (5L * doy + 2L) / 153L
    val d = (doy - (153L * mp + 2L) / 5L + 1L).toInt()
    val m = (if (mp < 10L) mp + 3L else mp - 9L).toInt()
    val year = (if (m <= 2) y + 1L else y)
    fun p2(n: Int) = if (n < 10) "0$n" else "$n"
    return "$year-${p2(m)}-${p2(d)}T${p2(hh)}:${p2(mm)}:${p2(ss)}Z"
}

/**
 * Firestore collection: dynamic_fields. Admin-defined custom fields that
 * other screens can render against the supported [appliesTo] entities. The
 * UI manager (`screens/admin/DynamicFieldsManagerScreen.kt`) does the CRUD;
 * downstream consumer screens read this stream and render the matching
 * fields. New types added here MUST also be handled by the manager UI's
 * type picker so admins can pick them.
 */
@Serializable
data class DynamicField(
    val _id: String = "",
    val name: String = "",            // unique key (snake_case) used in storage
    val label: String = "",           // human-facing label shown in the form
    val fieldType: String = "text",   // text|number|date|select|multiselect|email|phone|boolean|long_text
    val appliesTo: String = "kinfolk", // kinfolk|kin|session|booking
    val options: List<String> = emptyList(),
    val required: Boolean = false,
    val helpText: String = "",
    val displayOrder: Int = 0,
    val archived: Boolean = false,
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    companion object {
        val SUPPORTED_TYPES = listOf(
            "text", "long_text", "number", "boolean",
            "date", "email", "phone", "select", "multiselect",
        )
        val SUPPORTED_APPLIES_TO = listOf("kinfolk", "kin", "session", "booking")

        fun typeRequiresOptions(type: String): Boolean =
            type == "select" || type == "multiselect"
    }
}

/**
 * One note doc from `families/{fid}/bookings/{id}/notes/{noteId}` (kinfolk-facing,
 * read allowed for kinfolk + admin) OR `families/{fid}/bookings/{id}/internalNotes/{noteId}`
 * (admin-only, kinfolk DENIED at path level).
 *
 * authorRole tells UI whether to show "admin"/"kinfolk" badge; kinfolk-side UI
 * never receives admin-internal notes (rules deny read).
 */
@Serializable
data class BookingNote(
    val _id: String = "",
    val authorUid: String = "",
    val authorRole: String = "",
    val body: String = "",
    val createdAtMs: Long? = null,
)

/**
 * One KinTale comment read from kin_care_reports/{taleId}/comments. authorRole is
 * 'kinfolk' | 'admin' | 'guest'. guestName is only set for shared-link guest authors
 * (a MyTribe-only write path); the AuntieOS admin app always posts authorRole='admin'.
 * parentCommentId is null for a top-level comment, or the id of the comment it replies to
 * (1-level threading per spec).
 */
@Serializable
data class KinTaleComment(
    val _id: String = "",
    val authorRole: String = "",
    val authorUid: String? = null,
    val guestName: String? = null,
    val body: String = "",
    val parentCommentId: String? = null,
    val createdAtMs: Long? = null,
)

/**
 * Assignment fields of one kinCare visit doc
 * (families/{familyId}/bookings/{batchId}/kinCares/{visitId}). Both null on an
 * unassigned visit.
 */
data class KinCareAssignment(
    val assignedAuntieUid: String? = null,
    val auntieDisplayName: String? = null,
)

/**
 * One incoming per-visit KinCare from the MyTribe booking envelope, read via the
 * collectionGroup('kinCares') listener (status == 'requested'). [path] is the full
 * Firestore document path families/{familyId}/bookings/{batchId}/kinCares/{visitId}
 * - surfaced from the JS bridge as `_path` so the staff write-back can target the
 * originating doc without an extra read. [familyId]/[batchId]/[visitId] are derived
 * from [path] by [pathParts] for convenience.
 *
 * Field set is intentionally minimal (the scheduling queue only needs identity +
 * status + window); unknown keys are ignored by the lenient decoder.
 */
@Serializable
data class KinCareVisit(
    val _id: String = "",
    @SerialName("_path") val path: String = "",
    val familyId: String = "",
    val targetType: String = "",
    val targetId: String = "",
    val kinName: String = "",
    val kinfolkName: String = "",
    val serviceType: String = "",
    val title: String = "",
    val window: String = "",
    val startTime: String = "",
    val status: String = "",
    val visitProgress: String = "",
    val notes: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    /** Splits [path] into [familyId-of-path, batchId, visitId] (empty if malformed). */
    val pathParts: Triple<String, String, String>
        get() {
            // families/{fid}/bookings/{batchId}/kinCares/{visitId}
            val seg = path.split('/')
            return if (seg.size >= 6 && seg[0] == "families" && seg[2] == "bookings" && seg[4] == "kinCares") {
                Triple(seg[1], seg[3], seg[5])
            } else {
                Triple("", "", "")
            }
        }
}

/**
 * Outcome of a manageBookingSeries callable. [affectedVisits] = visits that
 * processed successfully; [failedVisits] > 0 means a PARTIAL failure (the backend
 * still returns ok:true and leaves the envelope 'requested'), so callers MUST
 * surface it fail-loud rather than report a clean success. [sessionsCreated] is
 * the count of linked kin_care_sessions the backend created on APPROVE.
 */
data class ManageSeriesResult(
    val affectedVisits: Int,
    val failedVisits: Int = 0,
    val sessionsCreated: Int = 0,
)

/** The two manageBookingSeries actions. Centralized so the UI dispatch, the
 *  callable arg, and tests cannot drift on a typo (the backend rejects unknown
 *  actions, but a typo would surface only as a generic runtime failure). */
object BookingSeriesAction {
    const val APPROVE = "APPROVE"
    const val CANCEL = "CANCEL"
}

/** KinCare lifecycle status values shared across the booking-envelope ingestion
 *  path (collectionGroup filter, fixtures, tests) so the literal lives once. */
object KinCareStatus {
    const val REQUESTED = "requested"
}

/**
 * Firestore collection: vet_clinics. Shared catalog of veterinary clinics used
 * by every Kinfolk household. Admins/Kinfolk can either pick an existing entry
 * (chip selector on the edit screen) or type a new clinic name - on save we
 * create a new doc here so it shows up next time.
 */
@Serializable
data class VetClinic(
    val _id: String = "",
    val name: String = "",
    val phone: String = "",
    val address: String = "",
    val notes: String = "",
    /** Clinic homepage. Optional. */
    val website: String = "",
    /** Deep-link to the Google Maps listing (directions/hours). Optional. */
    val googleMapsUrl: String = "",
    /** 24hr / emergency / urgent-care clinic. Drives the kinfolk emergency filter. */
    val isEmergency: Boolean = false,
    /**
     * Approval gate for the kinfolk-facing vet bank. Admin-authored clinics are
     * verified=true; a kinfolk add-new (submitVetClinic) lands verified=false and
     * is hidden from other households until the operator approves it here. A
     * MISSING flag (legacy docs) is treated as approved, so default = true.
     */
    val verified: Boolean = true,
    /** Firebase Auth uid of the kinfolk who submitted a pending entry (else ""). */
    val submittedBy: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
)

/**
 * Admin / Auntie user profile, stored at `users/{uid}`. Mirrors the Firebase
 * Auth uid into [_id] so the document can be loaded directly by uid.
 */
@Serializable
data class UserProfile(
    val _id: String = "",
    val uid: String = "",
    val email: String = "",
    val displayName: String = "",
    val firstName: String = "",
    val lastName: String = "",
    val phone: String = "",
    val title: String = "",
    val photoUrl: String = "",
    val bio: String = "",
    /**
     * Widget keys this admin wants visible on their Home dashboard. Empty list
     * means "show all" (the default for new users); any non-empty list is
     * treated as the explicit allow-list. See [HomeWidget] for valid keys.
     */
    val dashboardWidgets: List<String> = emptyList(),
    /**
     * 17.4 Nav editor: per-operator nav customization, ordered tokens "key" or
     * "key|Custom Label" (key = Destination.name). A known key absent = hidden; empty
     * list = the shipped grouped default. Resolved by [resolvedNav] in NavConfig.kt.
     */
    val navConfig: List<String> = emptyList(),
    /**
     * Per-operator UI theme preference: "LIGHT" / "DARK" / "SYSTEM". Blank on legacy
     * docs, which falls back to the app default (see [parseThemeMode]). Written via
     * [withTheme] + saveUserProfile so the chosen theme survives a refresh (0A).
     */
    val themeMode: String = "",
    /**
     * 17.1 personalization keys (blank on legacy docs -> app default; see
     * AccentChoice/DensityChoice/FontScaleChoice.parse). accentColor: "TEAL".."CORAL";
     * density: "COMPACT"/"NORMAL"/"ROOMY"; fontScale: "SMALL"/"MEDIUM"/"LARGE".
     * Written via withAccent/withDensity/withFontScale + saveUserProfile.
     */
    val accentColor: String = "",
    val density: String = "",
    val fontScale: String = "",
    /**
     * Named staff-UI theme preset key ("default", "midnight", ...; see
     * AuntieThemePreset.parse). Blank on legacy docs -> the "default" preset, so
     * the app reads byte-identical to pre-preset behavior. Written via
     * withThemePreset + saveUserProfile.
     */
    val themePreset: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
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

    val initials: String
        get() {
            if (firstName.isNotBlank() && lastName.isNotBlank()) {
                return "${firstName.first().uppercaseChar()}${lastName.first().uppercaseChar()}"
            }
            if (displayName.isNotBlank()) {
                val words = displayName.trim().split(Regex("\\s+"))
                return when {
                    words.size >= 2 -> "${words[0].first().uppercaseChar()}${words[1].first().uppercaseChar()}"
                    words[0].isNotBlank() -> words[0].first().uppercaseChar().toString()
                    else -> ""
                }
            }
            if (email.isNotBlank()) {
                return email.first().uppercaseChar().toString()
            }
            return ""
        }
}
