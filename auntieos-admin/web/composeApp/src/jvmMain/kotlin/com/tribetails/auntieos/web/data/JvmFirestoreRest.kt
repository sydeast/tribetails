package com.tribetails.auntieos.web.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.java.Java
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import com.tribetails.auntieos.web.observability.reportMessage

/**
 * Desktop (JVM) Firestore over the REST API.
 *
 * Desktop has no Firebase SDK, so reads/writes go through
 * https://firestore.googleapis.com/v1 with the signed-in user's bearer token
 * (from [jvmFirebaseIdToken]). Reads are exposed as polling Flows (Firestore's
 * real-time Listen channel needs gRPC, which plain JVM Ktor cannot do; polling
 * is fine for an admin console and keeps the screens' Flow contract intact).
 *
 * The crux is the typed-value bridge: Firestore REST wraps every field in a
 * {stringValue|integerValue|...} envelope, so [fsToPlain]/[plainToFs] convert
 * between that and the flat JSON our kotlinx-serialized models expect. The doc
 * id is injected as `_id` to match the wasm path.
 */
internal object JvmFirestoreRest {
    private const val PROJECT = "auntieos-ttpc"
    private const val BASE =
        "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents"
    private const val FUNCTIONS = "https://us-central1-$PROJECT.cloudfunctions.net"
    private const val POLL_MS = 8_000L

    @PublishedApi
    internal val codec = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }
    private val http = HttpClient(Java) { install(ContentNegotiation) { json(codec) } }

    // ── read: collection ────────────────────────────────────────────────────

    /** GET an entire collection (paginated), returning each doc as flat JSON with `_id`. */
    private suspend fun getCollection(collection: String): List<JsonObject> {
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val out = ArrayList<JsonObject>()
        var pageToken: String? = null
        do {
            val resp = http.get("$BASE/$collection") {
                header(HttpHeaders.Authorization, "Bearer $token")
                parameter("pageSize", "300")
                if (pageToken != null) parameter("pageToken", pageToken)
            }
            if (!resp.status.isSuccess()) error("Firestore ${resp.status.value}: ${resp.bodyAsText().take(180)}")
            val body = codec.parseToJsonElement(resp.bodyAsText()).jsonObject
            body["documents"]?.jsonArray?.forEach { out.add(docToPlain(it.jsonObject)) }
            pageToken = body["nextPageToken"]?.jsonPrimitive?.contentOrNull
        } while (pageToken != null)
        return out
    }

    private fun docToPlain(doc: JsonObject): JsonObject {
        val id = doc["name"]?.jsonPrimitive?.content?.substringAfterLast('/') ?: ""
        val fields = doc["fields"]?.jsonObject ?: JsonObject(emptyMap())
        return buildJsonObject {
            put("_id", id)
            for ((k, v) in fields) put(k, fsToPlain(v.jsonObject))
        }
    }

    /** Like [docToPlain] but also surfaces `_path` (the doc's relative path under
     *  /documents/) so collectionGroup results carry their parent path - needed by
     *  KinCareVisit.pathParts to recover families/{fid}/bookings/{batchId}/visitId. */
    private fun docToPlainWithPath(doc: JsonObject): JsonObject {
        val name = doc["name"]?.jsonPrimitive?.content ?: ""
        val relPath = name.substringAfter("/documents/", "")
        val fields = doc["fields"]?.jsonObject ?: JsonObject(emptyMap())
        return buildJsonObject {
            put("_id", name.substringAfterLast('/'))
            put("_path", relPath)
            for ((k, v) in fields) put(k, fsToPlain(v.jsonObject))
        }
    }

    /** Convert one Firestore typed value envelope to flat JSON. */
    private fun fsToPlain(value: JsonObject): JsonElement {
        val (type, raw) = value.entries.firstOrNull() ?: return JsonNull
        return when (type) {
            "stringValue", "referenceValue" -> raw
            "booleanValue" -> raw
            "integerValue" -> JsonPrimitive(raw.jsonPrimitive.content.toLongOrNull() ?: 0L)
            "doubleValue" -> raw
            "timestampValue" -> raw // ISO-8601 string; models read timestamps as strings
            "nullValue" -> JsonNull
            "arrayValue" -> buildJsonArray {
                raw.jsonObject["values"]?.jsonArray?.forEach { add(fsToPlain(it.jsonObject)) }
            }
            "mapValue" -> buildJsonObject {
                raw.jsonObject["fields"]?.jsonObject?.forEach { (k, v) -> put(k, fsToPlain(v.jsonObject)) }
            }
            "geoPointValue" -> raw
            else -> JsonNull
        }
    }

    /** Public raw accessor used by [list] and where-filtered reads. */
    suspend fun rawCollectionSuspend(collection: String): List<JsonObject> = getCollection(collection)

    /**
     * Stage 0I: a structured `:runQuery` filtered to `field == value`. Unlike
     * [getCollection], this sends the EQ predicate to the server, so a test admin
     * (whose rules forbid an unconstrained collection list) gets only its scoped
     * docs instead of a permission-denied. Each result is flattened to `_id`+fields
     * exactly like [docToPlain].
     */
    suspend fun runQueryWhereEq(collection: String, field: String, value: String): List<JsonObject> {
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val query = buildJsonObject {
            put("structuredQuery", buildJsonObject {
                put("from", buildJsonArray { add(buildJsonObject { put("collectionId", collection) }) })
                put("where", buildJsonObject {
                    put("fieldFilter", buildJsonObject {
                        put("field", buildJsonObject { put("fieldPath", field) })
                        put("op", "EQUAL")
                        put("value", buildJsonObject { put("stringValue", value) })
                    })
                })
            })
        }
        val resp = http.post("$BASE:runQuery") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(codec.encodeToString(JsonObject.serializer(), query))
        }
        if (!resp.status.isSuccess()) error("Firestore ${resp.status.value}: ${resp.bodyAsText().take(180)}")
        val arr = codec.parseToJsonElement(resp.bodyAsText()).jsonArray
        return arr.mapNotNull { row -> row.jsonObject["document"]?.jsonObject?.let { docToPlain(it) } }
    }

    /** Scoped equivalent of [list] that pushes the EQ predicate to the server. */
    suspend inline fun <reified T> listWhereEq(
        collection: String,
        field: String,
        value: String,
    ): List<T> {
        // WARNING-42: surface dropped docs so malformed records are not silently swallowed.
        val raw = runQueryWhereEq(collection, field, value)
        val decoded = raw.mapNotNull { doc ->
            runCatching { codec.decodeFromJsonElement<T>(doc) }
                .onFailure { e ->
                    val docId = doc["_id"]?.jsonPrimitive?.contentOrNull ?: "<unknown>"
                    val msg = "listWhereEq($collection,$field=$value): dropped doc $docId — ${e.message}"
                    System.err.println("[AuntieOS][firestore] $msg")
                    reportMessage(msg, fatal = false)
                }
                .getOrNull()
        }
        val dropped = raw.size - decoded.size
        if (dropped > 0) {
            val msg = "listWhereEq($collection,$field=$value): $dropped doc(s) dropped due to decode errors"
            System.err.println("[AuntieOS][firestore] $msg")
            reportMessage(msg, fatal = false)
        }
        return decoded
    }

    /**
     * A collectionGroup `:runQuery` filtered to `field == value`. Same as
     * [runQueryWhereEq] but `from.allDescendants = true` so it matches the named
     * subcollection at any depth (e.g. every kinCares under families/.../bookings). Each
     * result is flattened with `_path` so the parent path survives (16.5 incoming
     * kinCares queue). Public so [runCollectionGroupQueryWhereEqPlain] can be tested.
     */
    suspend fun runCollectionGroupQueryWhereEq(groupId: String, field: String, value: String): List<JsonObject> {
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val query = buildJsonObject {
            put("structuredQuery", buildJsonObject {
                put("from", buildJsonArray { add(buildJsonObject { put("collectionId", groupId); put("allDescendants", true) }) })
                put("where", buildJsonObject {
                    put("fieldFilter", buildJsonObject {
                        put("field", buildJsonObject { put("fieldPath", field) })
                        put("op", "EQUAL")
                        put("value", buildJsonObject { put("stringValue", value) })
                    })
                })
            })
        }
        val resp = http.post("$BASE:runQuery") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(codec.encodeToString(JsonObject.serializer(), query))
        }
        if (!resp.status.isSuccess()) error("Firestore ${resp.status.value}: ${resp.bodyAsText().take(180)}")
        val arr = codec.parseToJsonElement(resp.bodyAsText()).jsonArray
        return arr.mapNotNull { row -> row.jsonObject["document"]?.jsonObject?.let { docToPlainWithPath(it) } }
    }

    suspend inline fun <reified T> listCollectionGroupWhereEq(
        groupId: String,
        field: String,
        value: String,
    ): List<T> {
        // WARNING-42: surface dropped docs so malformed records are not silently swallowed.
        val raw = runCollectionGroupQueryWhereEq(groupId, field, value)
        val decoded = raw.mapNotNull { doc ->
            runCatching { codec.decodeFromJsonElement<T>(doc) }
                .onFailure { e ->
                    val docId = doc["_id"]?.jsonPrimitive?.contentOrNull ?: "<unknown>"
                    val msg = "listCollectionGroupWhereEq($groupId,$field=$value): dropped doc $docId — ${e.message}"
                    System.err.println("[AuntieOS][firestore] $msg")
                    reportMessage(msg, fatal = false)
                }
                .getOrNull()
        }
        val dropped = raw.size - decoded.size
        if (dropped > 0) {
            val msg = "listCollectionGroupWhereEq($groupId,$field=$value): $dropped doc(s) dropped due to decode errors"
            System.err.println("[AuntieOS][firestore] $msg")
            reportMessage(msg, fatal = false)
        }
        return decoded
    }

    /** Fetch + decode a collection into model T, optionally filtered on the flat JSON doc. */
    suspend inline fun <reified T> list(
        collection: String,
        predicate: (JsonObject) -> Boolean = { true },
    ): List<T> {
        // WARNING-42: surface dropped docs so malformed records are not silently swallowed.
        val raw = rawCollectionSuspend(collection).filter { predicate(it) }
        val decoded = raw.mapNotNull { doc ->
            runCatching { codec.decodeFromJsonElement<T>(doc) }
                .onFailure { e ->
                    val docId = doc["_id"]?.jsonPrimitive?.contentOrNull ?: "<unknown>"
                    val msg = "list($collection): dropped doc $docId — ${e.message}"
                    System.err.println("[AuntieOS][firestore] $msg")
                    reportMessage(msg, fatal = false)
                }
                .getOrNull()
        }
        val dropped = raw.size - decoded.size
        if (dropped > 0) {
            val msg = "list($collection): $dropped doc(s) dropped due to decode errors"
            System.err.println("[AuntieOS][firestore] $msg")
            reportMessage(msg, fatal = false)
        }
        return decoded
    }

    /** First decoded doc matching predicate, or null (for scalar/singleton reads). */
    suspend inline fun <reified T> first(
        collection: String,
        predicate: (JsonObject) -> Boolean = { true },
    ): T? = list<T>(collection, predicate).firstOrNull()

    /** GET a single document by id, as flat JSON with `_id`, or null when it does not exist. */
    suspend fun getDocPlain(collection: String, id: String): JsonObject? {
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val resp = http.get("$BASE/$collection/$id") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        if (resp.status.value == 404) return null
        if (!resp.status.isSuccess()) error("Firestore ${resp.status.value}: ${resp.bodyAsText().take(180)}")
        return docToPlain(codec.parseToJsonElement(resp.bodyAsText()).jsonObject)
    }

    /**
     * Read + decode a single document by id into model T, or null when absent.
     * WARNING-42: a present-but-undecodable doc now fails LOUD (System.err +
     * Sentry) instead of collapsing to a silent null, matching the list paths
     * above. It still returns null (there is no T to hand back on a decode
     * failure), but the failure is visible rather than swallowed.
     */
    suspend inline fun <reified T> getDoc(collection: String, id: String): T? =
        getDocPlain(collection, id)?.let { doc ->
            runCatching { codec.decodeFromJsonElement<T>(doc) }
                .onFailure { e ->
                    val docId = doc["_id"]?.jsonPrimitive?.contentOrNull ?: id
                    val msg = "getDoc($collection/$id): undecodable doc $docId — ${e.message}"
                    System.err.println("[AuntieOS][firestore] $msg")
                    reportMessage(msg, fatal = false)
                }
                .getOrNull()
        }

    // ── stream wrappers ──────────────────────────────────────────────────────

    fun <T> pollingStream(fetch: suspend () -> List<T>): Flow<FirestoreResult<List<T>>> = flow {
        while (true) {
            val r = runCatching { fetch() }
            emit(r.fold({ FirestoreResult.Data(it) }, { FirestoreResult.Error(it.message ?: "Firestore read failed") }))
            delay(POLL_MS)
        }
    }

    fun <T> pollingScalar(fetch: suspend () -> T): Flow<FirestoreResult<T>> = flow {
        while (true) {
            val r = runCatching { fetch() }
            emit(r.fold({ FirestoreResult.Data(it) }, { FirestoreResult.Error(it.message ?: "Firestore read failed") }))
            delay(POLL_MS)
        }
    }

    // ── write ─────────────────────────────────────────────────────────────────

    /** Convert flat JSON to a Firestore typed value envelope. */
    private fun plainToFs(element: JsonElement): JsonObject = when (element) {
        is JsonNull -> buildJsonObject { put("nullValue", "NULL_VALUE") }
        is JsonObject -> buildJsonObject {
            put("mapValue", buildJsonObject {
                put("fields", buildJsonObject { for ((k, v) in element) put(k, plainToFs(v)) })
            })
        }
        is JsonArray -> buildJsonObject {
            put("arrayValue", buildJsonObject { put("values", buildJsonArray { element.forEach { add(plainToFs(it)) } }) })
        }
        is JsonPrimitive -> when {
            element.isString -> buildJsonObject { put("stringValue", element.content) }
            element.booleanOrNullSafe() != null -> buildJsonObject { put("booleanValue", element.boolean) }
            element.longOrNull != null -> buildJsonObject { put("integerValue", element.content) }
            element.doubleOrNullSafe() != null -> buildJsonObject { put("doubleValue", JsonPrimitive(element.double)) }
            else -> buildJsonObject { put("stringValue", element.content) }
        }
    }

    private fun JsonPrimitive.booleanOrNullSafe(): Boolean? = content.toBooleanStrictOrNull()
    private fun JsonPrimitive.doubleOrNullSafe(): Double? = content.toDoubleOrNull()

    /** Build a Firestore document body (fields envelope) from a flat JSON object, dropping `_id`. */
    private fun bodyFrom(plain: JsonObject): JsonObject = buildJsonObject {
        put("fields", buildJsonObject {
            for ((k, v) in plain) if (k != "_id") put(k, plainToFs(v))
        })
    }

    /** PATCH (upsert) a document at collection/id from a serialized model. Returns the id. */
    suspend fun setDoc(collection: String, id: String, modelJson: String): String {
        // #825: recorded BEFORE the token fetch, exactly as #616 does for
        // `deleteDoc` and `patchFields` below, so a test with no credentials can
        // still assert WHICH write was attempted. That matters here because the
        // whole of #825 on this surface is the difference between a POST to a
        // collection and a PATCH at a caller-chosen id, and no assertion on a
        // return value can tell those apart.
        JvmFirestoreFixtures.lastWrite = RestWrite("PATCH", collection, id)
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val plain = codec.parseToJsonElement(modelJson).jsonObject
        val resp = http.patch("$BASE/$collection/$id") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(bodyFrom(plain).toString())
        }
        if (!resp.status.isSuccess()) error("Firestore write ${resp.status.value}: ${resp.bodyAsText().take(180)}")
        return id
    }

    /**
     * MERGE-write a document at collection/id from a serialized model. PATCHes with
     * an `updateMask.fieldPaths` covering exactly the body keys (every field of the
     * model except `_id`), so fields NOT present in the model are left untouched
     * rather than deleted.
     * Returns the id. Field paths are backtick-quoted to be safe for any key.
     */
    suspend fun mergeDoc(collection: String, id: String, modelJson: String): String {
        // #829: recorded BEFORE the token fetch, as [setDoc] and [addDoc] do, so a
        // test with no credentials can assert which fields the mask names.
        val plain = codec.parseToJsonElement(modelJson).jsonObject
        JvmFirestoreFixtures.lastWrite = RestWrite("MERGE", collection, id, plain.keys.filter { it != "_id" }.toSet())
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val paths = mergeFieldPaths(plain)
        val resp = http.patch("$BASE/$collection/$id") {
            header(HttpHeaders.Authorization, "Bearer $token")
            paths.forEach { parameter("updateMask.fieldPaths", it) }
            contentType(ContentType.Application.Json)
            setBody(bodyFrom(plain).toString())
        }
        if (!resp.status.isSuccess()) error("Firestore write ${resp.status.value}: ${resp.bodyAsText().take(180)}")
        return id
    }

    /**
     * #829 review: MERGE-write exactly [changes] at collection/id. Every change's
     * path goes in `updateMask.fieldPaths` (quoted by [firestoreFieldPath]); set
     * values go in the nested body, and a delete is a path in the mask that the body
     * leaves out, which Firestore removes. Lets `formValues.<key>` be written or
     * deleted without touching the other keys. Recorded before the token fetch,
     * with the encoded paths, so a test can assert the mask.
     */
    suspend fun mergeFieldChanges(collection: String, id: String, changes: List<KinfolkFieldChange>): String {
        val paths = changes.map { firestoreFieldPath(it.path) }
        JvmFirestoreFixtures.lastWrite = RestWrite("MERGE", collection, id, paths.toSet())
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val body = bodyFrom(kinfolkChangesBody(changes))
        val resp = http.patch("$BASE/$collection/$id") {
            header(HttpHeaders.Authorization, "Bearer $token")
            paths.forEach { parameter("updateMask.fieldPaths", it) }
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }
        if (!resp.status.isSuccess()) error("Firestore write ${resp.status.value}: ${resp.bodyAsText().take(180)}")
        return id
    }

    /**
     * Pure: the `updateMask.fieldPaths` for a merge write of [plain]. One backtick-
     * quoted path per top-level model key except `_id` (the doc-id alias, not a
     * field). Only these paths are touched, so unlisted sibling fields survive.
     */
    fun mergeFieldPaths(plain: JsonObject): List<String> =
        plain.keys.filter { it != "_id" }.map { "`$it`" }

    /** Create a doc with an auto id (POST to the collection). Returns the new id. */
    suspend fun addDoc(collection: String, modelJson: String): String {
        // #825: the twin of [setDoc]'s record above. The id is blank because
        // there is no id yet -- Firestore mints it -- and an unkeyed write having
        // no id of its own is precisely what the keyed path exists to change.
        // #829: also records the body's top-level keys, so a test can assert what a
        // create writes (a new household must not write the Emergency Contact keys).
        val plain = codec.parseToJsonElement(modelJson).jsonObject
        JvmFirestoreFixtures.lastWrite = RestWrite("POST", collection, "", plain.keys.filter { it != "_id" }.toSet())
        val token = jvmFirebaseIdToken() ?: error("Not signed in")
        val resp = http.post("$BASE/$collection") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(bodyFrom(plain).toString())
        }
        if (!resp.status.isSuccess()) error("Firestore create ${resp.status.value}: ${resp.bodyAsText().take(180)}")
        val name = codec.parseToJsonElement(resp.bodyAsText()).jsonObject["name"]?.jsonPrimitive?.content
        return name?.substringAfterLast('/') ?: ""
    }

    /** Hard-delete a doc (REST DELETE). Returns true on success. */
    suspend fun deleteDoc(collection: String, id: String): Boolean {
        JvmFirestoreFixtures.lastWrite = RestWrite("DELETE", collection, id)
        val token = jvmFirebaseIdToken() ?: return false
        val resp = http.delete("$BASE/$collection/$id") {
            header(HttpHeaders.Authorization, "Bearer $token")
        }
        return resp.status.isSuccess()
    }

    /** PATCH only the given fields of a doc (field-level update via updateMask). */
    suspend fun patchFields(collection: String, id: String, fields: Map<String, JsonElement>): Boolean {
        JvmFirestoreFixtures.lastWrite = RestWrite("PATCH", collection, id, fields.keys.toSet())
        val token = jvmFirebaseIdToken() ?: return false
        val resp = http.patch("$BASE/$collection/$id") {
            header(HttpHeaders.Authorization, "Bearer $token")
            fields.keys.forEach { parameter("updateMask.fieldPaths", it) }
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("fields", buildJsonObject { for ((k, v) in fields) put(k, plainToFs(v)) })
            }.toString())
        }
        return resp.status.isSuccess()
    }

    /**
     * Atomic mark-report-SENT commit (WARNING-15). Mirrors the wasm bridge's
     * `writeBatch`: one report `update` plus a session `update` whose mutations are
     * field-transforms — `arrayUnion(reportId)` on `reportIds` and `increment(1)`
     * on `sentReportCount` — so two concurrent sends never clobber each other's
     * cumulative state (the previous JVM path wrote client-computed reportIds /
     * sentReportCount via patchFields = last-write-wins). Both writes ride a single
     * Firestore `:commit`, so they apply atomically. Returns true on success.
     */
    suspend fun markReportSentAtomic(
        reportId: String,
        sessionId: String,
        sentVia: String,
        deliveryReceiptId: String,
        sentAtIso: String,
        updatedAtIso: String,
    ): Boolean {
        val token = jvmFirebaseIdToken() ?: return false
        val reportName = "$BASE/kin_care_reports/$reportId"
        val sessionName = "$BASE/kin_care_sessions/$sessionId"
        val body = buildJsonObject {
            put("writes", buildJsonArray {
                // 1) report doc: plain field update (masked so siblings survive).
                add(buildJsonObject {
                    put("update", buildJsonObject {
                        put("name", reportName)
                        put("fields", buildJsonObject {
                            put("status", plainToFs(JsonPrimitive("SENT")))
                            put("sentVia", plainToFs(JsonPrimitive(sentVia)))
                            put("sentAt", plainToFs(JsonPrimitive(sentAtIso)))
                            put("deliveryReceiptId", plainToFs(JsonPrimitive(deliveryReceiptId)))
                            put("updatedAt", plainToFs(JsonPrimitive(updatedAtIso)))
                        })
                    })
                    put("updateMask", buildJsonObject {
                        put("fieldPaths", buildJsonArray {
                            add("status"); add("sentVia"); add("sentAt")
                            add("deliveryReceiptId"); add("updatedAt")
                        })
                    })
                })
                // 2) session doc: atomic transforms (arrayUnion + increment) plus the
                //    plain autoCompleteEligible / updatedAt fields, masked to those two.
                add(buildJsonObject {
                    put("update", buildJsonObject {
                        put("name", sessionName)
                        put("fields", buildJsonObject {
                            put("autoCompleteEligible", plainToFs(JsonPrimitive(true)))
                            put("updatedAt", plainToFs(JsonPrimitive(updatedAtIso)))
                        })
                    })
                    put("updateMask", buildJsonObject {
                        put("fieldPaths", buildJsonArray { add("autoCompleteEligible"); add("updatedAt") })
                    })
                    put("updateTransforms", buildJsonArray {
                        add(buildJsonObject {
                            put("fieldPath", "reportIds")
                            put("appendMissingElements", buildJsonObject {
                                put("values", buildJsonArray { add(buildJsonObject { put("stringValue", reportId) }) })
                            })
                        })
                        add(buildJsonObject {
                            put("fieldPath", "sentReportCount")
                            put("increment", buildJsonObject { put("integerValue", "1") })
                        })
                    })
                })
            })
        }
        val resp = http.post("$BASE:commit") {
            header(HttpHeaders.Authorization, "Bearer $token")
            contentType(ContentType.Application.Json)
            setBody(codec.encodeToString(JsonObject.serializer(), body))
        }
        return resp.status.isSuccess()
    }

    // ── callable ────────────────────────────────────────────────────────────

    /** Invoke a 2nd-gen onCall HTTPS function. payloadJson is the `data` object. */
    suspend fun callable(name: String, payloadJson: String): WriteResult<String> {
        val token = jvmFirebaseIdToken()
        return try {
            val resp = http.post("$FUNCTIONS/$name") {
                if (token != null) header(HttpHeaders.Authorization, "Bearer $token")
                contentType(ContentType.Application.Json)
                setBody("{\"data\":$payloadJson}")
            }
            val text = resp.bodyAsText()
            if (!resp.status.isSuccess()) {
                val msg = runCatching {
                    codec.parseToJsonElement(text).jsonObject["error"]?.jsonObject
                        ?.get("message")?.jsonPrimitive?.content
                }.getOrNull() ?: "callable ${resp.status.value}"
                WriteResult.Err(msg)
            } else {
                val result = codec.parseToJsonElement(text).jsonObject["result"]
                WriteResult.Ok(result?.toString() ?: "{}")
            }
        } catch (e: Exception) {
            WriteResult.Err(e.message ?: "callable failed")
        }
    }
}
