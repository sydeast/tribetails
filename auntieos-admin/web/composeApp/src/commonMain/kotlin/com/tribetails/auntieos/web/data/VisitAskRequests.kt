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
 * #2243: the office's end of the two asks a household makes on a visit that is
 * already booked: a new time (`listRescheduleRequests` /
 * `resolveBookingRescheduleRequest`, #399 item 2) and a cancellation
 * (`listCancelRequests` / `resolveBookingCancellationRequest`, #438).
 *
 * The same four callables admin web (`api/rescheduleRequests.ts`,
 * `api/cancelRequests.ts`) and Android (`VisitRequestRepository`) call; the
 * shapes are the server's `RescheduleRequestDto` and `CancelRequestDto`
 * (`contracts/bookingContracts.generated.ts`). Every decoder ignores keys it
 * does not know.
 */

/** One visit with a proposed new time still waiting on a decision. */
data class RescheduleAsk(
    val kinfolkId: String,
    val batchId: String,
    val visitId: String,
    val kinfolkName: String? = null,
    val title: String? = null,
    val serviceType: String? = null,
    val kinNames: List<String> = emptyList(),
    val currentStartTimeMs: Long? = null,
    val proposedStartTimeMs: Long? = null,
    val reason: String? = null,
    val requestedAtMs: Long? = null,
)

/** One visit with a cancellation ask still waiting on a decision. */
data class CancelAsk(
    val kinfolkId: String,
    val batchId: String,
    val visitId: String,
    val kinfolkName: String? = null,
    val title: String? = null,
    val serviceType: String? = null,
    val kinNames: List<String> = emptyList(),
    val startTimeMs: Long? = null,
    val reason: String? = null,
    val requestedAtMs: Long? = null,
)

/** What `resolveBookingRescheduleRequest` answered. */
data class RescheduleAskAnswer(val decision: String, val sessionUpdated: Boolean)

/** What `resolveBookingCancellationRequest` answered. */
data class CancelAskAnswer(val decision: String, val sessionUpdated: Boolean)

/** The two answers a household's ask takes. */
enum class AskDecision(val wire: String) { ACCEPT("accept"), DECLINE("decline") }

private val askJson = Json { ignoreUnknownKeys = true; isLenient = true }

private fun JsonObject.text(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }

private fun JsonObject.millis(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.doubleOrNull?.toLong()

private fun JsonObject.names(key: String): List<String> =
    (this[key] as? JsonArray).orEmpty()
        .mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { n -> n.isNotEmpty() } }

private fun requestsOf(body: String): List<JsonObject> {
    val obj = askJson.parseToJsonElement(body).jsonObject
    val list = obj["requests"] as? JsonArray ?: error("The server answered without a list of requests.")
    return list.mapNotNull { it as? JsonObject }
}

/** Rows that do not name their household, booking and visit cannot be answered, so they are left out. */
private fun JsonObject.ids(): Triple<String, String, String>? {
    val kinfolkId = text("kinfolkId") ?: return null
    val batchId = text("batchId") ?: return null
    val visitId = text("visitId") ?: return null
    return Triple(kinfolkId, batchId, visitId)
}

/** Decodes a `listRescheduleRequests` answer. A body with no `requests` list is a failed read. */
fun decodeRescheduleAsks(body: String): List<RescheduleAsk> = requestsOf(body).mapNotNull { r ->
    val (kinfolkId, batchId, visitId) = r.ids() ?: return@mapNotNull null
    RescheduleAsk(
        kinfolkId = kinfolkId,
        batchId = batchId,
        visitId = visitId,
        kinfolkName = r.text("kinfolkName"),
        title = r.text("title"),
        serviceType = r.text("serviceType"),
        kinNames = r.names("kinNames"),
        currentStartTimeMs = r.millis("currentStartTimeMs"),
        proposedStartTimeMs = r.millis("proposedStartTimeMs"),
        reason = r.text("reason"),
        requestedAtMs = r.millis("requestedAtMs"),
    )
}

/** Decodes a `listCancelRequests` answer. A body with no `requests` list is a failed read. */
fun decodeCancelAsks(body: String): List<CancelAsk> = requestsOf(body).mapNotNull { r ->
    val (kinfolkId, batchId, visitId) = r.ids() ?: return@mapNotNull null
    CancelAsk(
        kinfolkId = kinfolkId,
        batchId = batchId,
        visitId = visitId,
        kinfolkName = r.text("kinfolkName"),
        title = r.text("title"),
        serviceType = r.text("serviceType"),
        kinNames = r.names("kinNames"),
        startTimeMs = r.millis("startTimeMs"),
        reason = r.text("reason"),
        requestedAtMs = r.millis("requestedAtMs"),
    )
}

private fun answerOf(body: String): Pair<String, Boolean> {
    val obj = askJson.parseToJsonElement(body).jsonObject
    val decision = obj.text("decision").orEmpty()
    val updated = (obj["sessionUpdated"] as? JsonPrimitive)?.booleanOrNull == true
    return decision to updated
}

fun decodeRescheduleAskAnswer(body: String): RescheduleAskAnswer =
    answerOf(body).let { (d, u) -> RescheduleAskAnswer(d, u) }

fun decodeCancelAskAnswer(body: String): CancelAskAnswer =
    answerOf(body).let { (d, u) -> CancelAskAnswer(d, u) }

/** The server takes at most this many characters of note with an answer (#2030). */
const val ASK_NOTE_MAX = 500

/**
 * The `resolveBookingRescheduleRequest` request. The note goes only when it has
 * words in it (#700: the office owes no reason), and each override only once the
 * operator chose "Accept anyway" over that refusal (#1100).
 */
fun resolveRescheduleAskPayload(
    ask: RescheduleAsk,
    decision: AskDecision,
    note: String,
    overrides: Set<ScheduleOverride> = emptySet(),
): JsonObject = buildJsonObject {
    put("kinfolkId", ask.kinfolkId)
    put("batchId", ask.batchId)
    put("visitId", ask.visitId)
    put("decision", decision.wire)
    note.trim().take(ASK_NOTE_MAX).takeIf { it.isNotEmpty() }?.let { put("note", it) }
    if (ScheduleOverride.BUSY in overrides) put("overrideBusyConflict", true)
    if (ScheduleOverride.VISIT in overrides) put("overrideVisitConflict", true)
}

/** The `resolveBookingCancellationRequest` request. The note goes only when it has words in it. */
fun resolveCancelAskPayload(ask: CancelAsk, decision: AskDecision, note: String): JsonObject = buildJsonObject {
    put("kinfolkId", ask.kinfolkId)
    put("batchId", ask.batchId)
    put("visitId", ask.visitId)
    put("decision", decision.wire)
    note.trim().take(ASK_NOTE_MAX).takeIf { it.isNotEmpty() }?.let { put("note", it) }
}

private fun encode(payload: JsonObject): String = askJson.encodeToString(JsonObject.serializer(), payload)

private suspend fun <T> askCall(name: String, payload: JsonObject, decode: (String) -> T): WriteResult<T> =
    when (val r = platformInvokeCallable(name, encode(payload))) {
        // The code rides along (#1100): "Accept anyway" is offered on a code, never on a sentence.
        is WriteResult.Err -> WriteResult.Err(r.message, r.code, r.details)
        is WriteResult.Ok -> com.tribetails.auntieos.web.observability.runCatchingCancellable { WriteResult.Ok(decode(r.value)) }
            .getOrElse { WriteResult.Err(it.message?.takeIf { m -> m.isNotBlank() } ?: "The server's answer could not be read.") }
    }

/** Every visit with a proposed new time still waiting on a decision. */
suspend fun listRescheduleAsks(): WriteResult<List<RescheduleAsk>> =
    askCall("listRescheduleRequests", buildJsonObject {}, ::decodeRescheduleAsks)

/** Every visit with a cancellation ask still waiting on a decision. */
suspend fun listCancelAsks(): WriteResult<List<CancelAsk>> =
    askCall("listCancelRequests", buildJsonObject {}, ::decodeCancelAsks)

/**
 * Accepts or declines a new time. ACCEPTING MOVES THE VISIT: the server writes the
 * household's visit and the schedule row together. A busy block or another visit
 * on the new time is refused with its `details.code`.
 */
suspend fun resolveRescheduleAsk(
    ask: RescheduleAsk,
    decision: AskDecision,
    note: String,
    overrides: Set<ScheduleOverride> = emptySet(),
): WriteResult<RescheduleAskAnswer> =
    askCall("resolveBookingRescheduleRequest", resolveRescheduleAskPayload(ask, decision, note, overrides), ::decodeRescheduleAskAnswer)

/** Accepts or declines a cancellation. ACCEPTING CANCELS THE VISIT on both records. */
suspend fun resolveCancelAsk(ask: CancelAsk, decision: AskDecision, note: String): WriteResult<CancelAskAnswer> =
    askCall("resolveBookingCancellationRequest", resolveCancelAskPayload(ask, decision, note), ::decodeCancelAskAnswer)
