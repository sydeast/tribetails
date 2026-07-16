package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.client.statement.bodyAsText
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlinx.serialization.encodeToString
import kotlinx.serialization.Serializable
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import com.tribetails.auntieos.web.observability.reportMessage

private val json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
}

/**
 * Single source of truth for reading the `ok` flag off a bridge response envelope
 * (NOTE-65). Bridge callbacks are stringified with `JSON.stringify`, so a real JS
 * boolean serializes to the JSON boolean `true` while some paths emit the string
 * `"true"`. This accepts both (a JSON boolean OR the string "true") so every call
 * site agrees, replacing the old mix of `booleanOrNull` (boolean-only) and
 * `toBooleanStrictOrNull` (string-only).
 */
internal fun JsonObject.okFlag(): Boolean {
    val prim = this["ok"]?.jsonPrimitive ?: return false
    return prim.booleanOrNull == true || prim.content.toBooleanStrictOrNull() == true
}

private val signerHttp = HttpClient {
    install(ContentNegotiation) {
        json(json)
    }
}

// ---------- JS interop (calls into window.__fb defined in index.html) ----------

@JsFun("() => { try { const p = window.__fb.currentUser(); if (!p || p === 'null') return ''; return JSON.parse(p).uid || ''; } catch(e) { return ''; } }")
private external fun jsCurrentUserUid(): String

@JsFun("() => { try { const p = window.__fb.currentUser(); if (!p || p === 'null') return ''; return JSON.parse(p).displayName || ''; } catch(e) { return ''; } }")
private external fun jsCurrentUserDisplayName(): String

@JsFun("(path, cb) => window.__fb.listenCollection(path, cb)")
private external fun jsListenCollection(path: String, cb: (String) -> Unit): JsAny

@JsFun("(path, id, cb) => window.__fb.listenDoc ? window.__fb.listenDoc(path, id, cb) : cb(JSON.stringify({ __error: 'listenDoc not on bridge' }))")
private external fun jsListenDoc(path: String, id: String, cb: (String) -> Unit): JsAny

@JsFun("(path, field, value, cb) => window.__fb.listenWhereEq(path, field, value, cb)")
private external fun jsListenWhereEq(path: String, field: String, value: String, cb: (String) -> Unit): JsAny

@JsFun("(groupId, field, value, cb) => window.__fb.listenCollectionGroupWhereEq ? window.__fb.listenCollectionGroupWhereEq(groupId, field, value, cb) : cb(JSON.stringify({ __error: 'listenCollectionGroupWhereEq not on bridge' }))")
private external fun jsListenCollectionGroupWhereEq(groupId: String, field: String, value: String, cb: (String) -> Unit): JsAny

@JsFun("(unsub) => window.__fb.unsubscribe(unsub)")
private external fun jsUnsubscribe(unsub: JsAny)

@JsFun("(path, json, cb) => window.__fb.addDocOnce(path, json, cb)")
private external fun jsAddDoc(path: String, json: String, cb: (String) -> Unit)

@JsFun("(path, id, json, cb) => window.__fb.setDocOnce(path, id, json, cb)")
private external fun jsSetDoc(path: String, id: String, json: String, cb: (String) -> Unit)

@JsFun("(path, id, json, cb) => window.__fb.updateDocOnce(path, id, json, cb)")
private external fun jsUpdateDoc(path: String, id: String, json: String, cb: (String) -> Unit)

@JsFun("(path, id, cb) => window.__fb.getDocOnce(path, id, cb)")
private external fun jsGetDoc(path: String, id: String, cb: (String) -> Unit)

@JsFun("(path, cb) => window.__fb.getCollectionOnce(path, cb)")
private external fun jsGetCollection(path: String, cb: (String) -> Unit)

@JsFun("(paramsJson, max, cb) => window.__fb.pickAndUploadKinTaleMedia(paramsJson, max, cb)")
private external fun jsPickAndUpload(paramsJson: String, max: Int, cb: (String) -> Unit)

@JsFun("(reportId, sessionId, sentVia, deliveryReceiptId, sentAtIso, cb) => window.__fb.markKinTaleReportSent(reportId, sessionId, sentVia, deliveryReceiptId, sentAtIso, cb)")
private external fun jsMarkKinTaleReportSent(
    reportId: String,
    sessionId: String,
    sentVia: String,
    deliveryReceiptId: String,
    sentAtIso: String,
    cb: (String) -> Unit,
)

@JsFun("(reportId, kinfolkId, kinfolkName, triagedBy, triagedAt, cb) => window.__fb.assignKinfolkToOrphanReport ? window.__fb.assignKinfolkToOrphanReport(reportId, kinfolkId, kinfolkName, triagedBy, triagedAt, cb) : cb(JSON.stringify({ ok: false, error: 'assignKinfolkToOrphanReport not on bridge' }))")
private external fun jsAssignKinfolkToOrphan(
    reportId: String,
    kinfolkId: String,
    kinfolkName: String,
    triagedBy: String,
    triagedAt: String,
    cb: (String) -> Unit,
)

@JsFun("(reportId, duplicateOfReportId, triagedBy, triagedAt, cb) => window.__fb.markOrphanReportAsDuplicate ? window.__fb.markOrphanReportAsDuplicate(reportId, duplicateOfReportId, triagedBy, triagedAt, cb) : cb(JSON.stringify({ ok: false, error: 'markOrphanReportAsDuplicate not on bridge' }))")
private external fun jsMarkOrphanReportAsDuplicate(
    reportId: String,
    duplicateOfReportId: String,
    triagedBy: String,
    triagedAt: String,
    cb: (String) -> Unit,
)

@JsFun("(reportId, reason, triagedBy, triagedAt, cb) => window.__fb.archiveOrphanReportAsBadData ? window.__fb.archiveOrphanReportAsBadData(reportId, reason, triagedBy, triagedAt, cb) : cb(JSON.stringify({ ok: false, error: 'archiveOrphanReportAsBadData not on bridge' }))")
private external fun jsArchiveOrphanReportAsBadData(
    reportId: String,
    reason: String,
    triagedBy: String,
    triagedAt: String,
    cb: (String) -> Unit,
)

@JsFun("(name, payloadJson, cb) => window.__fb.callFunction ? window.__fb.callFunction(name, payloadJson, cb) : cb(JSON.stringify({ ok: false, error: 'callFunction not on bridge' }))")
private external fun jsCallFunction(name: String, payloadJson: String, cb: (String) -> Unit)

@JsFun("(path, id, cb) => window.__fb.deleteDocOnce ? window.__fb.deleteDocOnce(path, id, cb) : cb(JSON.stringify({ ok: false, error: 'deleteDocOnce not on bridge' }))")
private external fun jsDeleteDoc(path: String, id: String, cb: (String) -> Unit)

// ---------- Helpers ----------

/**
 * The JS callback always passes a JSON string. It's either:
 *  - an array of documents `[{...}, {...}]` on success, or
 *  - an object `{"__error": "msg"}` on Firestore error.
 */
private fun parsePayload(payload: String): Result<JsonArray> = runCatching {
    val element = json.parseToJsonElement(payload)
    if (element is JsonObject) {
        val err = element["__error"]?.jsonPrimitive?.content
        if (err != null) error(err)
    }
    element as JsonArray
}

private inline fun <reified T> collectionStream(
    path: String,
): Flow<FirestoreResult<List<T>>> = callbackFlow {
    val unsub = jsListenCollection(path) { payload ->
        parsePayload(payload).fold(
            onSuccess = { array ->
                // WARNING-41: defensive decode — one bad doc must not fail the whole list.
                val list = array.mapNotNull { el ->
                    runCatching { json.decodeFromJsonElement<T>(el) }
                        .onFailure { e -> reportMessage("collectionStream($path): dropped malformed doc — ${e.message}", fatal = false) }
                        .getOrNull()
                }
                val dropped = array.size - list.size
                if (dropped > 0) reportMessage("collectionStream($path): $dropped doc(s) dropped due to decode errors", fatal = false)
                trySend(FirestoreResult.Data(list))
            },
            onFailure = { trySend(FirestoreResult.Error(it.message ?: "Firestore read failed")) },
        )
    }
    awaitClose { jsUnsubscribe(unsub) }
}.onStart { emit(FirestoreResult.Loading) }

private inline fun <reified T> whereEqStream(
    path: String,
    field: String,
    value: String,
): Flow<FirestoreResult<List<T>>> = callbackFlow {
    val unsub = jsListenWhereEq(path, field, value) { payload ->
        parsePayload(payload).fold(
            onSuccess = { array ->
                // WARNING-41: defensive decode — one bad doc must not fail the whole list.
                val list = array.mapNotNull { el ->
                    runCatching { json.decodeFromJsonElement<T>(el) }
                        .onFailure { e -> reportMessage("whereEqStream($path,$field=$value): dropped malformed doc — ${e.message}", fatal = false) }
                        .getOrNull()
                }
                val dropped = array.size - list.size
                if (dropped > 0) reportMessage("whereEqStream($path,$field=$value): $dropped doc(s) dropped due to decode errors", fatal = false)
                trySend(FirestoreResult.Data(list))
            },
            onFailure = { trySend(FirestoreResult.Error(it.message ?: "Firestore read failed")) },
        )
    }
    awaitClose { jsUnsubscribe(unsub) }
}.onStart { emit(FirestoreResult.Loading) }

// Single-doc listener wrapped as a (0 or 1)-element list, so a list-shaped caller
// (e.g. the Stage 0I scoped kinfolk stream) keeps its type. The bridge's listenDoc
// emits the doc inside a JSON array, or an empty array when the doc is missing.
private inline fun <reified T> docByIdStream(
    path: String,
    id: String,
): Flow<FirestoreResult<List<T>>> = callbackFlow {
    val unsub = jsListenDoc(path, id) { payload ->
        parsePayload(payload).fold(
            onSuccess = { array ->
                // WARNING-41: defensive decode — one bad doc must not fail the whole list.
                val list = array.mapNotNull { el ->
                    runCatching { json.decodeFromJsonElement<T>(el) }
                        .onFailure { e -> reportMessage("docByIdStream($path/$id): dropped malformed doc — ${e.message}", fatal = false) }
                        .getOrNull()
                }
                val dropped = array.size - list.size
                if (dropped > 0) reportMessage("docByIdStream($path/$id): $dropped doc(s) dropped due to decode errors", fatal = false)
                trySend(FirestoreResult.Data(list))
            },
            onFailure = { trySend(FirestoreResult.Error(it.message ?: "Firestore read failed")) },
        )
    }
    awaitClose { jsUnsubscribe(unsub) }
}.onStart { emit(FirestoreResult.Loading) }

// Collection-group listener filtered by an equality predicate. Each doc carries
// its full Firestore path as `_path` (surfaced by the bridge) so callers can
// derive the write-back path. Used by the booking-envelope ingestion stream.
private inline fun <reified T> collectionGroupWhereEqStream(
    groupId: String,
    field: String,
    value: String,
): Flow<FirestoreResult<List<T>>> = callbackFlow {
    val unsub = jsListenCollectionGroupWhereEq(groupId, field, value) { payload ->
        parsePayload(payload).fold(
            onSuccess = { array ->
                // WARNING-41: defensive decode — one bad doc must not fail the whole list.
                val list = array.mapNotNull { el ->
                    runCatching { json.decodeFromJsonElement<T>(el) }
                        .onFailure { e -> reportMessage("collectionGroupWhereEqStream($groupId,$field=$value): dropped malformed doc — ${e.message}", fatal = false) }
                        .getOrNull()
                }
                val dropped = array.size - list.size
                if (dropped > 0) reportMessage("collectionGroupWhereEqStream($groupId,$field=$value): $dropped doc(s) dropped due to decode errors", fatal = false)
                trySend(FirestoreResult.Data(list))
            },
            onFailure = { trySend(FirestoreResult.Error(it.message ?: "Firestore read failed")) },
        )
    }
    awaitClose { jsUnsubscribe(unsub) }
}.onStart { emit(FirestoreResult.Loading) }

// ---------- actuals ----------

internal actual fun platformKinfolkStream(): Flow<FirestoreResult<List<Kinfolk>>> =
    collectionStream("kinfolk")

// Stage 0I: a test admin can only get its own kinfolk doc, never list the
// collection. Firestore has no document-id field filter, so we read the single
// doc by id via a docSnapshot listener and wrap it in a one-element list (empty
// when missing) so callers keep their List shape.
internal actual fun platformKinfolkByIdStream(kinfolkId: String): Flow<FirestoreResult<List<Kinfolk>>> =
    docByIdStream<Kinfolk>("kinfolk", kinfolkId)

internal actual fun platformInvoicesForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<Invoice>>> =
    whereEqStream("invoices", "kinfolkId", kinfolkId)

internal actual fun platformPaymentsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<Payment>>> =
    whereEqStream("payments", "kinfolkId", kinfolkId)

internal actual fun platformReportsForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<KinCareReport>>> =
    whereEqStream("kin_care_reports", "kinfolkId", kinfolkId)

internal actual fun platformKinStream(kinfolkId: String): Flow<FirestoreResult<List<Kin>>> =
    whereEqStream("kin", "kinfolkId", kinfolkId)

internal actual fun platformAllKinStream(): Flow<FirestoreResult<List<Kin>>> =
    collectionStream("kin")

internal actual fun platformSessionsStream(): Flow<FirestoreResult<List<KinCareSession>>> =
    collectionStream("kin_care_sessions")

internal actual fun platformSessionsBySourceBookingIdStream(
    sourceBookingId: String,
): Flow<FirestoreResult<List<KinCareSession>>> =
    whereEqStream("kin_care_sessions", "sourceBookingId", sourceBookingId)

internal actual fun platformSessionsForKinfolkStream(
    kinfolkId: String,
): Flow<FirestoreResult<List<KinCareSession>>> =
    whereEqStream("kin_care_sessions", "kinfolkId", kinfolkId)

internal actual fun platformGeneratedDraftsStream(): Flow<FirestoreResult<List<GeneratedDraft>>> =
    collectionStream("generated_drafts")

internal actual suspend fun platformApproveGeneratedDraft(
    draftId: String,
    editedCopy: String,
): WriteResult<Unit> {
    require(draftId.isNotBlank()) { "approveGeneratedDraft requires a non-blank draftId" }
    val approvedAt = nowIsoUtc()
    // Encode through kotlinx.serialization to handle any control chars in
    // editedCopy safely (newlines, quotes, etc.).
    val patch = jsonOut.encodeToString(
        kotlinx.serialization.json.JsonObject(
            mapOf(
                "status" to kotlinx.serialization.json.JsonPrimitive("approved"),
                "generatedCopy" to kotlinx.serialization.json.JsonPrimitive(editedCopy),
                "approvedAt" to kotlinx.serialization.json.JsonPrimitive(approvedAt),
            ),
        ),
    )
    return when (val r = awaitWrite { cb -> jsUpdateDoc("generated_drafts", draftId, patch, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual fun platformReportsStream(): Flow<FirestoreResult<List<KinCareReport>>> =
    collectionStream("kin_care_reports")

internal actual fun platformVoicemailsStream(): Flow<FirestoreResult<List<VoicemailLog>>> =
    collectionStream("voicemails")

internal actual fun platformCallsStream(): Flow<FirestoreResult<List<CallLog>>> =
    collectionStream("calls_log")

internal actual fun platformSmsStream(): Flow<FirestoreResult<List<SmsMessage>>> =
    collectionStream("sms_messages")

internal actual fun platformEmailsStream(): Flow<FirestoreResult<List<EmailMessage>>> =
    collectionStream("emails")

internal actual fun platformInvoicesStream(): Flow<FirestoreResult<List<Invoice>>> =
    collectionStream("invoices")

internal actual fun platformActivityStream(): Flow<FirestoreResult<List<ActivityLogEntry>>> =
    collectionStream("activity_log")

internal actual fun platformNotificationsStream(): Flow<FirestoreResult<List<NotificationEntry>>> =
    collectionStream("notifications")

// ---------- Single-doc streams (filter-by-FK; matches the "one dossier per kinfolk" pattern) ----------

internal actual fun platformDossierStream(kinfolkId: String): Flow<FirestoreResult<Dossier?>> =
    whereEqStream<Dossier>("dossiers", "kinfolkId", kinfolkId).map { result ->
        when (result) {
            is FirestoreResult.Data    -> FirestoreResult.Data(result.value.firstOrNull())
            is FirestoreResult.Error   -> result
            FirestoreResult.Loading    -> FirestoreResult.Loading
        }
    }

internal actual fun platformKin411Stream(kinId: String): Flow<FirestoreResult<Kin411?>> =
    whereEqStream<Kin411>("the_411", "kinId", kinId).map { result ->
        when (result) {
            is FirestoreResult.Data    -> FirestoreResult.Data(result.value.firstOrNull())
            is FirestoreResult.Error   -> result
            FirestoreResult.Loading    -> FirestoreResult.Loading
        }
    }

// ---------- One-shot writes ----------

private val jsonOut = Json { encodeDefaults = true; explicitNulls = false }

/**
 * Awaits the JS-side write callback and parses its `{ ok, id?, error? }` envelope
 * into a [WriteResult]. We use suspendCancellableCoroutine so callers compose
 * naturally with viewModelScope / rememberCoroutineScope.
 */
private suspend fun awaitWrite(call: ((String) -> Unit) -> Unit): WriteResult<String> =
    suspendCancellableCoroutine { cont ->
        call { payload ->
            val parsed = runCatching {
                json.parseToJsonElement(payload).let { it as JsonObject }
            }.getOrElse {
                cont.resume(WriteResult.Err("invalid write response"))
                return@call
            }
            val ok = parsed.okFlag()
            if (ok) {
                cont.resume(WriteResult.Ok(parsed["id"]?.jsonPrimitive?.content.orEmpty()))
            } else {
                cont.resume(WriteResult.Err(parsed["error"]?.jsonPrimitive?.content ?: "unknown error"))
            }
        }
    }

internal actual suspend fun platformCreateKinfolk(k: Kinfolk): WriteResult<String> =
    awaitWrite { cb -> jsAddDoc("kinfolk", jsonOut.encodeToString(k), cb) }

internal actual suspend fun platformUpdateKinfolk(k: Kinfolk): WriteResult<Unit> {
    require(k._id.isNotBlank()) { "updateKinfolk requires a non-blank _id" }
    return when (val r = awaitWrite { cb -> jsSetDoc("kinfolk", k._id, jsonOut.encodeToString(k), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformArchiveKinfolk(id: String): WriteResult<Unit> {
    require(id.isNotBlank()) { "archiveKinfolk requires a non-blank id" }
    val patch = """{"status":"archived"}"""
    return when (val r = awaitWrite { cb -> jsUpdateDoc("kinfolk", id, patch, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformCreateKin(k: Kin): WriteResult<String> =
    awaitWrite { cb -> jsAddDoc("kin", jsonOut.encodeToString(k), cb) }

internal actual suspend fun platformUpdateKin(k: Kin): WriteResult<Unit> {
    require(k._id.isNotBlank()) { "updateKin requires a non-blank _id" }
    return when (val r = awaitWrite { cb -> jsSetDoc("kin", k._id, jsonOut.encodeToString(k), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformArchiveKin(id: String): WriteResult<Unit> {
    require(id.isNotBlank()) { "archiveKin requires a non-blank id" }
    val patch = """{"status":"archived"}"""
    return when (val r = awaitWrite { cb -> jsUpdateDoc("kin", id, patch, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual fun platformIncomingKinCaresStream(): Flow<FirestoreResult<List<KinCareVisit>>> =
    collectionGroupWhereEqStream("kinCares", "status", KinCareStatus.REQUESTED)

internal actual suspend fun platformPatchKinCareDoc(
    familyId: String,
    batchId: String,
    visitId: String,
    patch: Map<String, String>,
): WriteResult<Unit> {
    require(familyId.isNotBlank() && batchId.isNotBlank() && visitId.isNotBlank()) {
        "patchKinCareDoc requires non-blank familyId/batchId/visitId"
    }
    require(patch.isNotEmpty()) { "patchKinCareDoc requires at least one field" }
    val obj = kotlinx.serialization.json.buildJsonObject {
        patch.forEach { (k, v) -> put(k, kotlinx.serialization.json.JsonPrimitive(v)) }
    }
    val payload = jsonOut.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
    return when (val r = awaitWrite { cb -> jsUpdateDoc("families/$familyId/bookings/$batchId/kinCares", visitId, payload, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformGetKinCareAssignment(
    familyId: String,
    batchId: String,
    visitId: String,
): WriteResult<KinCareAssignment?> {
    require(familyId.isNotBlank() && batchId.isNotBlank() && visitId.isNotBlank()) {
        "getKinCareAssignment requires non-blank familyId/batchId/visitId"
    }
    return suspendCancellableCoroutine { cont ->
        jsGetDoc("families/$familyId/bookings/$batchId/kinCares", visitId) { payload ->
            try {
                val obj = json.parseToJsonElement(payload).jsonObject
                if (!obj.okFlag()) {
                    cont.resume(WriteResult.Err(obj["error"]?.jsonPrimitive?.contentOrNull ?: "unknown_error"))
                    return@jsGetDoc
                }
                val data = obj["data"] as? JsonObject
                cont.resume(WriteResult.Ok(data?.let {
                    KinCareAssignment(
                        assignedAuntieUid = it["assignedAuntieUid"]?.jsonPrimitive?.contentOrNull,
                        auntieDisplayName = it["auntieDisplayName"]?.jsonPrimitive?.contentOrNull,
                    )
                }))
            } catch (t: Throwable) {
                cont.resume(WriteResult.Err(t.message ?: "parse_error"))
            }
        }
    }
}

internal actual suspend fun platformPatchKinCare(id: String, patch: Map<String, String>): WriteResult<Unit> {
    require(id.isNotBlank()) { "patchKinCare requires a non-blank id" }
    require(patch.isNotEmpty()) { "patchKinCare requires at least one field" }
    val obj = kotlinx.serialization.json.buildJsonObject {
        patch.forEach { (k, v) ->
            put(k, kotlinx.serialization.json.JsonPrimitive(v))
        }
    }
    val payload = jsonOut.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
    return when (val r = awaitWrite { cb -> jsUpdateDoc("kin_care_sessions", id, payload, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformMarkVoicemailReplied(
    voicemailId: String,
    repliedAtIso: String,
    replyLogId: String,
): WriteResult<Unit> {
    require(voicemailId.isNotBlank()) { "markVoicemailReplied requires a non-blank voicemailId" }
    require(repliedAtIso.isNotBlank()) { "markVoicemailReplied requires repliedAtIso" }
    val obj = kotlinx.serialization.json.buildJsonObject {
        put("replyStatus", kotlinx.serialization.json.JsonPrimitive("replied"))
        put("repliedAt", kotlinx.serialization.json.JsonPrimitive(repliedAtIso))
        put("replyLogId", kotlinx.serialization.json.JsonPrimitive(replyLogId))
    }
    val payload = jsonOut.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
    return when (val r = awaitWrite { cb -> jsUpdateDoc("voicemails", voicemailId, payload, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformMarkVoicemailRead(voicemailId: String): WriteResult<Unit> {
    require(voicemailId.isNotBlank()) { "markVoicemailRead requires a non-blank voicemailId" }
    val obj = kotlinx.serialization.json.buildJsonObject {
        put("replyStatus", kotlinx.serialization.json.JsonPrimitive("read"))
    }
    val payload = jsonOut.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
    return when (val r = awaitWrite { cb -> jsUpdateDoc("voicemails", voicemailId, payload, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

// ---------- KinTale templates + reports ----------

internal actual fun platformTemplatesStream(): Flow<FirestoreResult<List<KinTaleTemplate>>> =
    collectionStream("kintale_templates")

internal actual suspend fun platformCreateKinTaleReport(report: KinCareReport): WriteResult<String> {
    val now = nowIsoUtc()
    val stamped = report.copy(
        authorId = jsCurrentUserUid(),
        authorDisplayName = jsCurrentUserDisplayName().ifBlank { "Auntie" },
        createdAt = now,
        updatedAt = now,
    )
    return awaitWrite { cb -> jsAddDoc("kin_care_reports", jsonOut.encodeToString(stamped), cb) }
}

internal actual suspend fun platformUpdateKinTaleReport(report: KinCareReport): WriteResult<Unit> {
    require(report._id.isNotBlank()) { "updateKinTaleReport requires a non-blank _id" }
    val stamped = report.copy(updatedAt = nowIsoUtc())
    return when (val r = awaitWrite { cb -> jsSetDoc("kin_care_reports", report._id, jsonOut.encodeToString(stamped), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformMarkKinTaleReportSent(
    reportId: String,
    sessionId: String,
    sentVia: String,
    deliveryReceiptId: String,
    sentAtIso: String,
): WriteResult<Unit> {
    require(reportId.isNotBlank()) { "markKinTaleReportSent requires a non-blank reportId" }
    require(sessionId.isNotBlank()) { "markKinTaleReportSent requires a non-blank sessionId" }
    return when (val write = awaitWrite { cb ->
        jsMarkKinTaleReportSent(
            reportId = reportId,
            sessionId = sessionId,
            sentVia = sentVia,
            deliveryReceiptId = deliveryReceiptId,
            sentAtIso = sentAtIso,
            cb = cb,
        )
    }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> write
    }
}

internal actual suspend fun platformAssignKinfolkToOrphan(
    reportId: String,
    kinfolkId: String,
    kinfolkName: String,
): WriteResult<Unit> {
    require(reportId.isNotBlank()) { "assignKinfolkToOrphan requires a non-blank reportId" }
    require(kinfolkId.isNotBlank()) { "assignKinfolkToOrphan requires a non-blank kinfolkId" }
    val triagedBy = jsCurrentUserUid()
    val triagedAt = nowIsoUtc()
    return when (val r = awaitWrite { cb ->
        jsAssignKinfolkToOrphan(
            reportId = reportId,
            kinfolkId = kinfolkId,
            kinfolkName = kinfolkName,
            triagedBy = triagedBy,
            triagedAt = triagedAt,
            cb = cb,
        )
    }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformMarkOrphanReportAsDuplicate(
    reportId: String,
    duplicateOfReportId: String,
): WriteResult<Unit> {
    require(reportId.isNotBlank()) { "markOrphanReportAsDuplicate requires a non-blank reportId" }
    require(duplicateOfReportId.isNotBlank()) {
        "markOrphanReportAsDuplicate requires a non-blank duplicateOfReportId"
    }
    val triagedBy = jsCurrentUserUid()
    val triagedAt = nowIsoUtc()
    return when (val r = awaitWrite { cb ->
        jsMarkOrphanReportAsDuplicate(
            reportId = reportId,
            duplicateOfReportId = duplicateOfReportId,
            triagedBy = triagedBy,
            triagedAt = triagedAt,
            cb = cb,
        )
    }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformArchiveOrphanReportAsBadData(
    reportId: String,
    reason: String,
): WriteResult<Unit> {
    require(reportId.isNotBlank()) { "archiveOrphanReportAsBadData requires a non-blank reportId" }
    require(reason.isNotBlank()) { "archiveOrphanReportAsBadData requires a non-blank reason" }
    val triagedBy = jsCurrentUserUid()
    val triagedAt = nowIsoUtc()
    return when (val r = awaitWrite { cb ->
        jsArchiveOrphanReportAsBadData(
            reportId = reportId,
            reason = reason,
            triagedBy = triagedBy,
            triagedAt = triagedAt,
            cb = cb,
        )
    }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

private fun nowIsoUtc(): String = com.tribetails.auntieos.web.util.nowIso()

// ---------- Media (Cloudinary unsigned upload + Firestore metadata) ----------

internal actual fun platformMediaForSessionStream(sessionId: String): Flow<FirestoreResult<List<MediaFile>>> =
    whereEqStream<MediaFile>("media_files", "entityId", sessionId)

internal actual suspend fun platformDeleteKinTaleMedia(mediaFileId: String): WriteResult<Unit> {
    require(mediaFileId.isNotBlank()) { "deleteKinTaleMedia requires a non-blank id" }
    return when (val r = awaitWrite { cb -> jsDeleteDoc("media_files", mediaFileId, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual fun platformMediaStream(entityId: String, entityType: String): Flow<FirestoreResult<List<MediaFile>>> =
    whereEqStream<MediaFile>("media_files", "entityId", entityId).map { result ->
        when (result) {
            is FirestoreResult.Data -> FirestoreResult.Data(result.value.filter { it.entityType == entityType })
            else -> result
        }
    }

// #13 Gallery: full-collection + per-kinfolk media streams + a taggedKinIds-only update.
internal actual fun platformAllMediaStream(): Flow<FirestoreResult<List<MediaFile>>> =
    collectionStream("media_files")

internal actual fun platformMediaForKinfolkStream(kinfolkId: String): Flow<FirestoreResult<List<MediaFile>>> =
    whereEqStream<MediaFile>("media_files", "kinfolkId", kinfolkId)

internal actual suspend fun platformUpdateMediaTags(mediaId: String, taggedKinIds: List<String>): WriteResult<Unit> {
    require(mediaId.isNotBlank()) { "updateMediaTags requires a non-blank id" }
    val patch = jsonOut.encodeToString(MediaTagsPatch(taggedKinIds))
    return when (val r = awaitWrite { cb -> jsUpdateDoc("media_files", mediaId, patch, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformUploadMedia(
    entityId: String,
    entityType: String,
    bytes: ByteArray,
    mimeType: String,
): WriteResult<MediaFile> {
    require(entityId.isNotBlank()) { "uploadMedia requires a non-blank entityId" }
    // Single-file entry (profile photos, logos). Routes through the shared core with
    // max=1 and returns the one saved record.
    return when (val r = pickUploadAndSaveMedia(entityId, entityType, max = 1)) {
        is WriteResult.Ok  ->
            r.value.firstOrNull()?.let { WriteResult.Ok(it) }
                ?: WriteResult.Err("no file returned from upload")
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformPickAndUploadMedia(
    entityId: String,
    entityType: String,
    max: Int,
): WriteResult<List<MediaFile>> {
    require(entityId.isNotBlank()) { "pickAndUploadMedia requires a non-blank entityId" }
    if (max <= 0) return WriteResult.Ok(emptyList())
    return pickUploadAndSaveMedia(entityId, entityType, max)
}

/**
 * Run-4 #4b shared core: signed upload -> picker (up to [max] files) -> decode EVERY
 * file (pure, unit-tested [decodeUploadedMedia]) -> sandbox-scope + write each to
 * media_files. Both the single [platformUploadMedia] and the multi
 * [platformPickAndUploadMedia] route through here so the decode and per-file write
 * are identical. Previously the single path hardcoded max=1 and kept only the first
 * file, so selecting several images saved one (the #4 bug).
 */
private suspend fun pickUploadAndSaveMedia(
    entityId: String,
    entityType: String,
    max: Int,
): WriteResult<List<MediaFile>> {
    val signedUpload = when (val s = fetchSignedUpload("tribetails/entity/$entityId", entityType, entityId)) {
        is WriteResult.Ok  -> s.value
        is WriteResult.Err -> return s
    }
    val payload: String = suspendCancellableCoroutine { cont ->
        jsPickAndUpload(
            jsonOut.encodeToString(CloudinarySignedUpload.serializer(), signedUpload),
            max,
        ) { resp -> cont.resume(resp) }
    }
    val decoded = when (
        val d = decodeUploadedMedia(
            envelopeJson = payload,
            entityId = entityId,
            entityType = entityType,
            nowIso = nowIsoUtc(),
            // Real signed-in uploader (was hardcoded "auntie"); single-admin fallback only.
            uploadedBy = jsCurrentUserUid().ifBlank { "auntie" },
        )
    ) {
        is WriteResult.Ok  -> d.value
        is WriteResult.Err -> return d
    }
    // Stage 0I: a test admin must stamp kinfolkId == testTribeId or the rules deny the write.
    val sandboxTribe = platformTestTribeId(forceRefresh = false)
    val saved = mutableListOf<MediaFile>()
    for (record in decoded) {
        val scoped = record.withSandboxScope(sandboxTribe)
        when (val r = awaitWrite { cb -> jsAddDoc("media_files", jsonOut.encodeToString(scoped), cb) }) {
            is WriteResult.Ok  -> saved += scoped.copy(_id = r.value)
            is WriteResult.Err -> return WriteResult.Err("Couldn't save media metadata: ${r.message}")
        }
    }
    return WriteResult.Ok(saved)
}

internal actual suspend fun platformDeleteMedia(mediaId: String): WriteResult<Unit> {
    require(mediaId.isNotBlank()) { "deleteMedia requires a non-blank id" }
    return when (val r = awaitWrite { cb -> jsDeleteDoc("media_files", mediaId, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

// ---------- Template editor writes ----------

internal actual suspend fun platformCreateKinTaleTemplate(template: KinTaleTemplate): WriteResult<String> {
    val now = nowIsoUtc()
    val stamped = template.copy(createdAt = now, updatedAt = now)
    return awaitWrite { cb -> jsAddDoc("kintale_templates", jsonOut.encodeToString(stamped), cb) }
}

internal actual suspend fun platformUpdateKinTaleTemplate(template: KinTaleTemplate): WriteResult<Unit> {
    require(template._id.isNotBlank()) { "updateKinTaleTemplate requires a non-blank _id" }
    val stamped = template.copy(updatedAt = nowIsoUtc())
    return when (val r = awaitWrite { cb -> jsSetDoc("kintale_templates", template._id, jsonOut.encodeToString(stamped), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformDeleteKinTaleTemplate(templateId: String): WriteResult<Unit> {
    require(templateId.isNotBlank()) { "deleteKinTaleTemplate requires a non-blank id" }
    return when (val r = awaitWrite { cb -> jsDeleteDoc("kintale_templates", templateId, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

/**
 * Picker → Cloudinary upload → Firestore metadata write, all in one round-trip.
 *
 * The JS bridge handles the file picker + upload because both touch the DOM and
 * are awkward from wasmJs. We get back a JSON envelope:
 *   { ok: true, files: [{ publicId, secureUrl, resourceType, format,
 *                         width, height, durationSeconds, originalFileName,
 *                         fileSizeBytes, mimeType, createdAtIso }] }
 * For each file, we synthesize a [MediaFile] (mirroring Android's shape so the
 * Firestore doc round-trips with the mobile app), write it to `media_files`,
 * and return the saved record (with the assigned `_id`).
 */
internal actual suspend fun platformPickAndUploadKinTaleMedia(
    sessionId: String,
    remainingSlots: Int,
): WriteResult<List<MediaFile>> {
    require(sessionId.isNotBlank()) { "pickAndUploadKinTaleMedia requires a non-blank sessionId" }
    if (remainingSlots <= 0) return WriteResult.Ok(emptyList())

    val signedUpload = when (val s = fetchSignedUpload(KinTaleMediaConfig.folderFor(sessionId), "VISIT_LOG", sessionId)) {
        is WriteResult.Ok  -> s.value
        is WriteResult.Err -> return s
    }

    val payload: String = suspendCancellableCoroutine { cont ->
        jsPickAndUpload(
            jsonOut.encodeToString(CloudinarySignedUpload.serializer(), signedUpload),
            remainingSlots,
        ) { resp -> cont.resume(resp) }
    }

    val envelope = runCatching { json.parseToJsonElement(payload) as JsonObject }
        .getOrElse { return WriteResult.Err("invalid upload response") }
    val ok = envelope.okFlag()
    if (!ok) {
        return WriteResult.Err(envelope["error"]?.jsonPrimitive?.content ?: "upload failed")
    }
    val files = (envelope["files"] as? JsonArray).orEmpty()
    if (files.isEmpty()) return WriteResult.Ok(emptyList())

    val saved = mutableListOf<MediaFile>()
    val nowIso = nowIsoUtc()
    // Stage 0I sandbox scope (blank for the operator), fetched once for the batch.
    val sandboxTribe = platformTestTribeId(forceRefresh = false)
    for (item in files) {
        val obj = item as? JsonObject ?: continue
        val publicId   = obj["publicId"]?.jsonPrimitive?.content.orEmpty()
        val secureUrl  = obj["secureUrl"]?.jsonPrimitive?.content.orEmpty()
        val resType    = obj["resourceType"]?.jsonPrimitive?.content.orEmpty()
        val format     = obj["format"]?.jsonPrimitive?.content.orEmpty()
        val width      = obj["width"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0
        val height     = obj["height"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0
        val duration   = obj["durationSeconds"]?.jsonPrimitive?.content?.toDoubleOrNull()?.toInt() ?: 0
        val original   = obj["originalFileName"]?.jsonPrimitive?.content.orEmpty()
        val sizeBytes  = obj["fileSizeBytes"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L
        val mimeType   = obj["mimeType"]?.jsonPrimitive?.content.orEmpty()
        val isVideo    = resType.equals("video", ignoreCase = true)

        val record = MediaFile(
            entityId         = sessionId,
            entityType       = "VISIT_LOG",
            fileName         = publicId.substringAfterLast('/').ifBlank { original },
            originalFileName = original,
            fileType         = if (isVideo) "VIDEO" else "IMAGE",
            mimeType         = mimeType,
            fileSizeBytes    = sizeBytes,
            storageUrl       = if (isVideo) KinTaleMediaConfig.deliveryUrl(publicId, true, format) else secureUrl,
            thumbnailUrl     = KinTaleMediaConfig.thumbnailUrl(publicId, isVideo),
            uploadedAt       = nowIso,
            uploadedBy       = jsCurrentUserUid().ifBlank { "auntie" }, // real signed-in uploader; single-admin fallback
            tags             = listOf("kintale"),
            durationSeconds  = duration,
            width            = width,
            height           = height,
            cloudinaryPublicId = publicId,
        )
        val scoped = record.withSandboxScope(sandboxTribe)
        when (val r = awaitWrite { cb -> jsAddDoc("media_files", jsonOut.encodeToString(scoped), cb) }) {
            is WriteResult.Ok  -> saved += scoped.copy(_id = r.value)
            is WriteResult.Err -> return WriteResult.Err("Couldn't save media metadata: ${r.message}")
        }
    }
    return WriteResult.Ok(saved)
}

@Serializable
private data class CloudinarySignUploadRequest(
    val folder: String,
    val entityType: String,
    val entityId: String,
)

// Fail-loud: returns a clear WriteResult.Err carrying the server's real reason
// (HTTP status + error body) instead of throwing opaquely on any non-2xx, so an
// upload that fails tells the operator WHY (e.g. cloudinary_signing_not_configured,
// forbidden) rather than silently dying.
private suspend fun fetchSignedUpload(folder: String, entityType: String, entityId: String): WriteResult<CloudinarySignedUpload> {
    val idToken = AuthClient().idToken(forceRefresh = false)
        ?: return WriteResult.Err("Not signed in. Sign in as an admin, then try the upload again.")
    val response = runCatching {
        signerHttp.post("/api/cloudinary/sign-upload") {
            contentType(ContentType.Application.Json)
            header("Authorization", "Bearer $idToken")
            setBody(
                CloudinarySignUploadRequest(
                    folder = folder,
                    entityType = entityType,
                    entityId = entityId,
                )
            )
        }
    }.getOrElse { e ->
        return WriteResult.Err("Upload signer unreachable: ${e.message ?: "network error"}")
    }
    if (response.status.value !in 200..299) {
        val raw = runCatching { response.bodyAsText() }.getOrDefault("")
        val serverMsg = runCatching {
            (json.parseToJsonElement(raw) as? JsonObject)?.get("error")?.jsonPrimitive?.content
        }.getOrNull()
        return WriteResult.Err(
            "Upload signing failed (HTTP ${response.status.value}): " +
                (serverMsg ?: raw.take(120).ifBlank { "no detail from server" })
        )
    }
    return runCatching { WriteResult.Ok(response.body<CloudinarySignedUpload>()) }
        .getOrElse { e -> WriteResult.Err("Upload signer returned an unreadable response: ${e.message ?: "parse error"}") }
}

// ---------- Business settings ----------

// Canonical settings doc: business_settings/business_settings (2026-06-05
// unification). Listen to the specific doc, not firstOrNull() of the collection.
internal actual fun platformBusinessSettingsStream(): Flow<FirestoreResult<BusinessSettings>> =
    callbackFlow {
        val unsub = jsListenDoc("business_settings", BUSINESS_SETTINGS_DOC_ID) { payload ->
            parsePayload(payload).fold(
                onSuccess = { array ->
                    val settings = array.firstOrNull()?.let {
                        runCatching { json.decodeFromJsonElement<BusinessSettings>(it) }.getOrNull()
                    } ?: BusinessSettings()
                    trySend(FirestoreResult.Data(settings))
                },
                onFailure = { trySend(FirestoreResult.Error(it.message ?: "unknown")) },
            )
        }
        awaitClose { jsUnsubscribe(unsub) }
    }.onStart { emit(FirestoreResult.Loading) }

// Always write the canonical doc id; jsSetDoc -> setDocOnce merges (merge:true).
internal actual suspend fun platformSaveBusinessSettings(settings: BusinessSettings): WriteResult<Unit> {
    val stamped = settings.copy(_id = BUSINESS_SETTINGS_DOC_ID, updatedAt = nowIsoUtc())
    return when (val r = awaitWrite { cb -> jsSetDoc("business_settings", BUSINESS_SETTINGS_DOC_ID, jsonOut.encodeToString(stamped), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

// ---------- Booking requests ----------

internal actual fun platformBookingRequestsStream(): Flow<FirestoreResult<List<KinCareSession>>> =
    whereEqStream<KinCareSession>("kin_care_sessions", "status", "DRAFT")

internal actual suspend fun platformApproveBooking(bookingId: String): WriteResult<Unit> {
    require(bookingId.isNotBlank()) { "approveBooking requires a non-blank bookingId" }
    val patch = """{"status":"SCHEDULED"}"""
    return when (val r = awaitWrite { cb -> jsUpdateDoc("kin_care_sessions", bookingId, patch, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformRejectBooking(bookingId: String): WriteResult<Unit> {
    require(bookingId.isNotBlank()) { "rejectBooking requires a non-blank bookingId" }
    val patch = """{"status":"CANCELLED"}"""
    return when (val r = awaitWrite { cb -> jsUpdateDoc("kin_care_sessions", bookingId, patch, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformCreateBookingRequest(booking: KinCareSession): WriteResult<String> {
    val now = nowIsoUtc()
    val status = booking.status.ifBlank { "DRAFT" }
    val stamped = booking.copy(status = status, createdAt = now, updatedAt = now)
    return awaitWrite { cb -> jsAddDoc("kin_care_sessions", jsonOut.encodeToString(stamped), cb) }
}

// ---------- Payments ----------

internal actual fun platformPaymentsStream(): Flow<FirestoreResult<List<Payment>>> =
    collectionStream("payments")

internal actual fun platformBookingTimeSlotsStream(): Flow<FirestoreResult<List<BookingTimeSlot>>> =
    collectionStream("booking_time_slots")

internal actual suspend fun platformRecordPayment(payment: Payment): WriteResult<String> =
    awaitWrite { cb -> jsAddDoc("payments", jsonOut.encodeToString(payment), cb) }

// ---------- Training Documents ----------

internal actual fun platformTrainingDocsStream(): Flow<FirestoreResult<List<TrainingDocument>>> =
    collectionStream("training_documents")

// ---------- Admin / Auntie user profiles ----------

internal actual fun platformUserProfileStream(uid: String): Flow<FirestoreResult<UserProfile?>> =
    whereEqStream<UserProfile>("users", "uid", uid).map { result ->
        when (result) {
            is FirestoreResult.Data    -> FirestoreResult.Data(result.value.firstOrNull())
            is FirestoreResult.Error   -> result
            FirestoreResult.Loading    -> FirestoreResult.Loading
        }
    }

internal actual suspend fun platformSaveUserProfile(profile: UserProfile): WriteResult<Unit> {
    require(profile.uid.isNotBlank()) { "saveUserProfile requires a non-blank uid" }
    val now = nowIsoUtc()
    val createdAt = profile.createdAt.ifBlank { now }
    val stamped = profile.copy(
        _id       = profile.uid,
        createdAt = createdAt,
        updatedAt = now,
    )
    return when (val r = awaitWrite { cb -> jsSetDoc("users", profile.uid, jsonOut.encodeToString(stamped), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

// ---------- Vet clinics ----------

internal actual fun platformVetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>> =
    collectionStream("vet_clinics")

internal actual suspend fun platformCreateVetClinic(clinic: VetClinic): WriteResult<String> {
    val now = nowIsoUtc()
    val stamped = clinic.copy(createdAt = clinic.createdAt.ifBlank { now }, updatedAt = now)
    return awaitWrite { cb -> jsAddDoc("vet_clinics", jsonOut.encodeToString(stamped), cb) }
}

internal actual suspend fun platformUpdateVetClinic(clinic: VetClinic): WriteResult<Unit> {
    require(clinic._id.isNotBlank()) { "updateVetClinic requires a non-blank _id" }
    val stamped = clinic.copy(updatedAt = nowIsoUtc())
    return when (val r = awaitWrite { cb -> jsSetDoc("vet_clinics", clinic._id, jsonOut.encodeToString(stamped), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformDeleteVetClinic(id: String): WriteResult<Unit> {
    require(id.isNotBlank()) { "deleteVetClinic requires a non-blank id" }
    return when (val r = awaitWrite { cb -> jsDeleteDoc("vet_clinics", id, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

// ---------- Activity log writes ----------

// 2026-05-26: routes through the server `logActivity` callable instead of
// jsAddDoc("activity_log", ...) so the SHA-256 hash chain in writeAuditEntry
// (MyTribe functions) seals every client-origin entry too. Closes C-A
// residual chain hole. Callable is admin-gated server-side and re-derives
// the actor uid from req.auth.uid; the client-supplied actorId is captured
// in the description only when it diverges (forensic correlation).
internal actual suspend fun platformLogActivity(entry: ActivityLogEntry): WriteResult<String> {
    val payload = buildJsonObject {
        put("actionType", JsonPrimitive(entry.actionType))
        if (entry.description.isNotBlank()) put("description", JsonPrimitive(entry.description))
        if (entry.status.isNotBlank()) put("status", JsonPrimitive(entry.status))
        if (entry.actorId.isNotBlank()) put("actorId", JsonPrimitive(entry.actorId))
        if (entry.targetId.isNotBlank()) put("targetId", JsonPrimitive(entry.targetId))
        if (entry.targetCollection.isNotBlank()) put("targetCollection", JsonPrimitive(entry.targetCollection))
    }
    return callFunction("logActivity", payload) { dataJson ->
        runCatching {
            json.parseToJsonElement(dataJson).jsonObject["entryId"]?.jsonPrimitive?.contentOrNull.orEmpty()
        }.getOrElse { "" }
    }
}

// ---------- Dynamic fields ----------

internal actual fun platformDynamicFieldsStream(): Flow<FirestoreResult<List<DynamicField>>> =
    collectionStream("dynamic_fields")

internal actual suspend fun platformCreateDynamicField(field: DynamicField): WriteResult<String> {
    val now = nowIsoUtc()
    val stamped = field.copy(
        createdAt = field.createdAt.ifBlank { now },
        updatedAt = now,
    )
    return awaitWrite { cb -> jsAddDoc("dynamic_fields", jsonOut.encodeToString(stamped), cb) }
}

internal actual suspend fun platformUpdateDynamicField(field: DynamicField): WriteResult<Unit> {
    require(field._id.isNotBlank()) { "updateDynamicField requires a non-blank _id" }
    val stamped = field.copy(updatedAt = nowIsoUtc())
    return when (val r = awaitWrite { cb -> jsSetDoc("dynamic_fields", field._id, jsonOut.encodeToString(stamped), cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformArchiveDynamicField(id: String): WriteResult<Unit> {
    require(id.isNotBlank()) { "archiveDynamicField requires a non-blank id" }
    val patch = """{"archived":true,"updatedAt":"${nowIsoUtc()}"}"""
    return when (val r = awaitWrite { cb -> jsUpdateDoc("dynamic_fields", id, patch, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

// ---------- GPS breadcrumbs (subcollection per session) ----------

internal actual fun platformBreadcrumbsStream(sessionId: String): Flow<FirestoreResult<List<Breadcrumb>>> {
    require(sessionId.isNotBlank()) { "breadcrumbsStream requires a non-blank sessionId" }
    return collectionStream<Breadcrumb>("kin_care_sessions/$sessionId/breadcrumbs")
        .map { result ->
            when (result) {
                is FirestoreResult.Data    -> FirestoreResult.Data(result.value.sortedBy { it.timestamp })
                is FirestoreResult.Error   -> result
                FirestoreResult.Loading    -> FirestoreResult.Loading
            }
        }
}

internal actual suspend fun platformAddBreadcrumb(sessionId: String, crumb: Breadcrumb): WriteResult<String> {
    require(sessionId.isNotBlank()) { "addBreadcrumb requires a non-blank sessionId" }
    val stamped = crumb.copy(timestamp = crumb.timestamp.ifBlank { nowIsoUtc() })
    return awaitWrite { cb ->
        jsAddDoc("kin_care_sessions/$sessionId/breadcrumbs", jsonOut.encodeToString(stamped), cb)
    }
}

// ---------- Booking notes subcollections ----------
// Reads use existing collectionStream helper. Writes are gated to Functions
// callables (`addBookingNote` / `addInternalBookingNote`) per Firestore rules
// `allow write: if false` on these subcollections. Functions-callable JS binding
// not yet implemented in wasmJs - stub until that infrastructure lands.
internal actual fun platformBookingNotesStream(
    kinfolkId: String,
    bookingId: String,
    internal: Boolean,
    visitId: String,
): Flow<FirestoreResult<List<BookingNote>>> {
    require(kinfolkId.isNotBlank() && bookingId.isNotBlank()) {
        "bookingNotesStream requires non-blank ids"
    }
    val sub = if (internal) "internalNotes" else "notes"
    // Blank visitId → legacy flat path; non-blank → nested envelope path under
    // the kinCares/{visitId} visit (bookingId treated as batchId).
    val base = if (visitId.isBlank()) "families/$kinfolkId/bookings/$bookingId"
               else "families/$kinfolkId/bookings/$bookingId/kinCares/$visitId"
    return collectionStream<BookingNote>("$base/$sub")
        .map { result ->
            when (result) {
                is FirestoreResult.Data    -> FirestoreResult.Data(result.value.sortedBy { it.createdAtMs ?: 0L })
                is FirestoreResult.Error   -> result
                FirestoreResult.Loading    -> FirestoreResult.Loading
            }
        }
}

internal actual suspend fun platformAddBookingNote(
    kinfolkId: String,
    bookingId: String,
    body: String,
    internal: Boolean,
    visitId: String,
): WriteResult<String> {
    require(kinfolkId.isNotBlank() && bookingId.isNotBlank()) {
        "addBookingNote requires non-blank ids"
    }
    require(body.isNotBlank()) { "addBookingNote body cannot be blank" }
    val name = if (internal) "addInternalBookingNote" else "addBookingNote"
    val payload = buildJsonObject {
        put("kinfolkId", JsonPrimitive(kinfolkId))
        put("bookingId", JsonPrimitive(bookingId))
        put("body", JsonPrimitive(body))
        // Envelope path: when visitId is present, also send batchId (= bookingId)
        // + visitId so the server writes under kinCares/{visitId}. Server falls
        // back to the legacy flat bookingId path when these are absent.
        if (visitId.isNotBlank()) {
            put("batchId", JsonPrimitive(bookingId))
            put("visitId", JsonPrimitive(visitId))
        }
    }
    return callFunction(name, payload) { dataJson ->
        runCatching {
            val obj = json.parseToJsonElement(dataJson).jsonObject
            obj["noteId"]?.jsonPrimitive?.contentOrNull.orEmpty()
        }.getOrElse { "" }
    }
}

// KinTale comment thread. Admin direct-reads the comments subcollection (Firestore
// rules allow isAuntie() read); kinfolkId is unused on this platform (the jvm callable
// read needs it). Posts go through the addKinTaleComment callable (server forces
// authorRole='admin'). Listener failure surfaces as FirestoreResult.Error (fail-loud).
internal actual fun platformKinTaleCommentsStream(
    taleId: String,
    kinfolkId: String,
): Flow<FirestoreResult<List<KinTaleComment>>> {
    require(taleId.isNotBlank()) { "kinTaleCommentsStream requires a non-blank taleId" }
    return collectionStream<KinTaleComment>("kin_care_reports/$taleId/comments")
        .map { result ->
            when (result) {
                is FirestoreResult.Data    -> FirestoreResult.Data(result.value.sortedBy { it.createdAtMs ?: 0L })
                is FirestoreResult.Error   -> result
                FirestoreResult.Loading    -> FirestoreResult.Loading
            }
        }
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
        if (!parentCommentId.isNullOrBlank()) {
            put("parentCommentId", JsonPrimitive(parentCommentId))
        }
    }
    return callFunction("addKinTaleComment", payload) { dataJson ->
        runCatching {
            val obj = json.parseToJsonElement(dataJson).jsonObject
            obj["commentId"]?.jsonPrimitive?.contentOrNull.orEmpty()
        }.getOrElse { "" }
    }
}

/**
 * Invokes a v2 onCall Firebase Function via the JS bridge. Auth context is
 * attached by the Firebase SDK from the signed-in user. Returns the parsed
 * result via [extract] (typically a single field off the response body).
 */
private suspend fun callFunction(
    name: String,
    payload: JsonObject,
    extract: (String) -> String,
): WriteResult<String> {
    val payloadStr = jsonOut.encodeToString(JsonObject.serializer(), payload)
    return when (val r = platformInvokeCallable(name, payloadStr)) {
        is WriteResult.Ok -> WriteResult.Ok(extract(r.value))
        is WriteResult.Err -> WriteResult.Err(r.message)
    }
}

/**
 * Raw callable invoker. On success, returns the response's `data` field as a
 * JSON string for the caller to decode. On failure, returns the JS-side error.
 */
internal actual suspend fun platformInvokeCallable(
    name: String,
    payloadJson: String,
): WriteResult<String> = suspendCancellableCoroutine { cont ->
    jsCallFunction(name, payloadJson) { responseStr ->
        val parsed = runCatching {
            json.parseToJsonElement(responseStr).jsonObject
        }.getOrElse {
            cont.resume(WriteResult.Err("invalid callable response"))
            return@jsCallFunction
        }
        val ok = parsed.okFlag()
        if (!ok) {
            cont.resume(WriteResult.Err(parsed["error"]?.jsonPrimitive?.contentOrNull ?: "callable failed"))
            return@jsCallFunction
        }
        val dataField = parsed["data"]?.jsonPrimitive?.contentOrNull.orEmpty()
        cont.resume(WriteResult.Ok(dataField))
    }
}

internal actual suspend fun platformGetBreadcrumbs(sessionId: String): WriteResult<List<Breadcrumb>> {
    require(sessionId.isNotBlank()) { "getBreadcrumbs requires a non-blank sessionId" }
    return suspendCancellableCoroutine { cont ->
        jsGetCollection("kin_care_sessions/$sessionId/breadcrumbs") { payload ->
            try {
                val obj = kotlinx.serialization.json.Json.parseToJsonElement(payload).jsonObject
                val ok = obj.okFlag()
                if (!ok) {
                    val err = obj["error"]?.jsonPrimitive?.contentOrNull ?: "unknown_error"
                    cont.resume(WriteResult.Err(err))
                    return@jsGetCollection
                }
                val arr = obj["data"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())
                val list = arr.map { jsonOut.decodeFromJsonElement(Breadcrumb.serializer(), it) }
                    .sortedBy { it.timestamp }
                cont.resume(WriteResult.Ok(list))
            } catch (t: Throwable) {
                cont.resume(WriteResult.Err(t.message ?: "parse_error"))
            }
        }
    }
}

internal actual suspend fun platformSaveSessionGpsSummary(
    sessionId: String,
    summary: GpsSummary,
): WriteResult<Unit> {
    require(sessionId.isNotBlank()) { "saveSessionGpsSummary requires a non-blank sessionId" }
    val obj = kotlinx.serialization.json.buildJsonObject {
        put("gpsSummary", jsonOut.encodeToJsonElement(GpsSummary.serializer(), summary))
    }
    val payload = jsonOut.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
    return when (val r = awaitWrite { cb -> jsUpdateDoc("kin_care_sessions", sessionId, payload, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

// ---------- Household Data (kinfolk-keyed dossier extension) ----------

internal actual suspend fun platformGetHouseholdData(kinfolkId: String): WriteResult<HouseholdData?> {
    require(kinfolkId.isNotBlank()) { "getHouseholdData requires a non-blank kinfolkId" }
    return suspendCancellableCoroutine { cont ->
        jsGetCollection("household_data") { payload ->
            try {
                val obj = kotlinx.serialization.json.Json.parseToJsonElement(payload).jsonObject
                val ok  = obj.okFlag()
                if (!ok) {
                    val err = obj["error"]?.jsonPrimitive?.contentOrNull ?: "unknown_error"
                    cont.resume(WriteResult.Err(err))
                    return@jsGetCollection
                }
                val arr = obj["data"]?.jsonArray ?: kotlinx.serialization.json.JsonArray(emptyList())
                val match = arr
                    .map { jsonOut.decodeFromJsonElement(HouseholdData.serializer(), it) }
                    .firstOrNull { it.kinfolkId == kinfolkId }
                cont.resume(WriteResult.Ok(match))
            } catch (t: Throwable) {
                cont.resume(WriteResult.Err(t.message ?: "parse_error"))
            }
        }
    }
}

internal actual suspend fun platformSaveHouseholdData(data: HouseholdData): WriteResult<Unit> {
    require(data.kinfolkId.isNotBlank()) { "saveHouseholdData requires a non-blank kinfolkId" }
    val now     = nowIsoUtc()
    val stamped = data.copy(
        createdAt = data.createdAt.ifBlank { now },
        updatedAt = now,
    )
    val r = if (data._id.isBlank()) {
        awaitWrite { cb -> jsAddDoc("household_data", jsonOut.encodeToString(stamped), cb) }
    } else {
        awaitWrite { cb -> jsSetDoc("household_data", data._id, jsonOut.encodeToString(stamped), cb) }
    }
    return when (r) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformUpdateInvoiceSessionIds(
    invoiceId: String,
    sessionIds: List<String>,
): WriteResult<Unit> {
    require(invoiceId.isNotBlank()) { "updateInvoiceSessionIds requires a non-blank invoiceId" }
    val now = nowIsoUtc()
    val obj = buildJsonObject {
        put("sessionIds", buildJsonArray { sessionIds.forEach { add(JsonPrimitive(it)) } })
        put("_attribution", JsonPrimitive("manual"))
        put("_attributionAt", JsonPrimitive(now))
        put("updatedAt", JsonPrimitive(now))
    }
    val payload = jsonOut.encodeToString(JsonObject.serializer(), obj)
    return when (val r = awaitWrite { cb -> jsUpdateDoc("invoices", invoiceId, payload, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}

internal actual suspend fun platformUpdateSessionInvoiceId(
    sessionId: String,
    invoiceId: String,
): WriteResult<Unit> {
    require(sessionId.isNotBlank()) { "updateSessionInvoiceId requires a non-blank sessionId" }
    val now = nowIsoUtc()
    val attribution = if (invoiceId.isBlank()) "manual_unlink" else "manual"
    val obj = buildJsonObject {
        put("invoiceId", JsonPrimitive(invoiceId))
        put("_attribution", JsonPrimitive(attribution))
        put("_attributionAt", JsonPrimitive(now))
        put("updatedAt", JsonPrimitive(now))
    }
    val payload = jsonOut.encodeToString(JsonObject.serializer(), obj)
    return when (val r = awaitWrite { cb -> jsUpdateDoc("kin_care_sessions", sessionId, payload, cb) }) {
        is WriteResult.Ok  -> WriteResult.Ok(Unit)
        is WriteResult.Err -> r
    }
}
