package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * #2121: the office's end of a household's request to remove a Kin that has
 * history on file (#1408). The household deletes a Kin with nothing on file
 * itself; with visits, KinTales, photos or records on file it asks, and the
 * owner archives the Kin (nothing is deleted) or declines with an optional note.
 *
 * The same two callables admin web (`api/kinRemovalRequests.ts`) and Android
 * (`KinRemovalRequestRepository`) call: `listKinRemovalRequests` and
 * `resolveKinRemovalRequest` (`mytribe/functions/src/admin/kinRemovalRequests.ts`).
 * Answering is the owner's: the server refuses an Auntie and a sandbox test admin.
 */

/** One waiting request, the server's `KinRemovalRequestDto`. */
data class KinRemovalRequest(
    val id: String,
    val kinfolkId: String,
    /** The household's own copy, `families/{kinfolkId}/kin/{kinId}`. */
    val kinId: String,
    /** The flat `kin/{id}` record the console opens. */
    val flatKinId: String? = null,
    val kinName: String? = null,
    val reason: String? = null,
    val status: String = "pending",
    val requestedAtMs: Long? = null,
)

/** The two answers a removal request takes. */
enum class KinRemovalDecision(val wire: String) { ARCHIVE("archive"), DECLINE("decline") }

/** What `resolveKinRemovalRequest` answered. */
data class KinRemovalAnswer(
    val decision: KinRemovalDecision,
    val kinName: String?,
    /** False when the household's notice could not be queued; the decision still stands. */
    val householdNotified: Boolean,
)

private val removalJson = Json { ignoreUnknownKeys = true; isLenient = true }

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun requestOf(r: JsonObject): KinRemovalRequest? {
    val id = r.text("id") ?: return null
    return KinRemovalRequest(
        id = id,
        kinfolkId = r.text("kinfolkId").orEmpty(),
        kinId = r.text("kinId").orEmpty(),
        flatKinId = r.text("flatKinId"),
        kinName = r.text("kinName"),
        reason = r.text("reason"),
        status = r.text("status") ?: "pending",
        requestedAtMs = (r["requestedAtMs"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.doubleOrNull?.toLong(),
    )
}

/**
 * Decodes a `listKinRemovalRequests` answer: the waiting requests only. A body
 * with no `requests` list is a failed read, never an empty queue.
 */
fun decodeKinRemovalRequests(body: String): List<KinRemovalRequest> {
    val obj = removalJson.parseToJsonElement(body).jsonObject
    val list = obj["requests"] as? JsonArray ?: error("The server answered without a list of requests.")
    return list.mapNotNull { (it as? JsonObject)?.let(::requestOf) }.filter { it.status == "pending" }
}

/** Decodes a `resolveKinRemovalRequest` answer. */
fun decodeKinRemovalAnswer(body: String, sent: KinRemovalDecision): KinRemovalAnswer {
    val obj = removalJson.parseToJsonElement(body).jsonObject
    val decision = KinRemovalDecision.entries.firstOrNull { it.wire == obj.text("decision") } ?: sent
    val kinName = (obj["request"] as? JsonObject)?.text("kinName")
    val told = (obj["householdNotified"] as? JsonPrimitive)?.booleanOrNull == true
    return KinRemovalAnswer(decision, kinName, told)
}

/** The server takes at most this many characters of note with an answer. */
const val KIN_REMOVAL_NOTE_MAX = 500

/** The `resolveKinRemovalRequest` request. The note goes only when it has words in it. */
fun resolveKinRemovalPayload(requestId: String, decision: KinRemovalDecision, note: String): JsonObject = buildJsonObject {
    put("requestId", requestId)
    put("decision", decision.wire)
    note.trim().take(KIN_REMOVAL_NOTE_MAX).takeIf { it.isNotEmpty() }?.let { put("note", it) }
}

/** Every removal request waiting on the office, oldest first. */
suspend fun listKinRemovalRequests(): WriteResult<List<KinRemovalRequest>> =
    when (val r = platformInvokeCallable("listKinRemovalRequests", "{}")) {
        is WriteResult.Err -> WriteResult.Err(r.message, r.code, r.details)
        is WriteResult.Ok -> com.tribetails.auntieos.web.observability.runCatchingCancellable { WriteResult.Ok(decodeKinRemovalRequests(r.value)) }
            .getOrElse { WriteResult.Err(it.message?.takeIf { m -> m.isNotBlank() } ?: "The server's answer could not be read.") }
    }

/** Archives the Kin or declines. Owner only. */
suspend fun resolveKinRemovalRequest(requestId: String, decision: KinRemovalDecision, note: String): WriteResult<KinRemovalAnswer> {
    val payload = removalJson.encodeToString(JsonObject.serializer(), resolveKinRemovalPayload(requestId, decision, note))
    return when (val r = platformInvokeCallable("resolveKinRemovalRequest", payload)) {
        is WriteResult.Err -> WriteResult.Err(r.message, r.code, r.details)
        is WriteResult.Ok -> com.tribetails.auntieos.web.observability.runCatchingCancellable { WriteResult.Ok(decodeKinRemovalAnswer(r.value, decision)) }
            .getOrElse { WriteResult.Err(it.message?.takeIf { m -> m.isNotBlank() } ?: "The server's answer could not be read.") }
    }
}
