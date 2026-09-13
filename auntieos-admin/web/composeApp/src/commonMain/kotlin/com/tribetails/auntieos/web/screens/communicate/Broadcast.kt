package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast (Stage 2 step 6): pure criteria model + validation + JSON codecs.
//
// All decision logic lives here (not in the composable / ViewModel) so it is
// unit-tested on pure JVM in commonTest. The server
// (MyTribe functions/src/admin/broadcastMessage.ts + audienceSegments.ts) is the
// source of truth and re-validates everything; these are honest pre-flight checks
// + the wire codecs the FirestoreClient consumes.
// ─────────────────────────────────────────────────────────────────────────────

/** A broadcast delivery channel. Wire value matches the broadcastMessage callable. */
enum class BroadcastChannel(val wire: String, val label: String) {
    InApp("inapp", "In-app"),
    Email("email", "Email"),
    Sms("sms", "Text"),
    Push("push", "Push"),
}

/** How a saved segment selects kinfolk. Wire value matches the criteria schema. */
enum class SegmentKind(val wire: String, val label: String) {
    All("all", "All active kinfolk"),
    Status("status", "By status"),
    Tags("tags", "By tag"),
}

/** Tag match mode for [SegmentKind.Tags]. */
enum class TagMatch(val wire: String, val label: String) {
    Any("any", "Any tag"),
    All("all", "All tags"),
}

/**
 * Audience segment criteria. Mirrors the server CriteriaSchema. Only the fields
 * relevant to [kind] are sent; the rest are ignored by the server.
 */
data class BroadcastCriteria(
    val kind: SegmentKind = SegmentKind.All,
    val statuses: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val tagMatch: TagMatch = TagMatch.Any,
)

/** A saved audience segment returned by listAudienceSegments. */
data class AudienceSegment(
    val id: String,
    val name: String,
    val criteria: BroadcastCriteria,
    val description: String,
    val updatedAtMs: Long,
)

/** Per-channel fan-out tally from a broadcast send. */
data class ChannelCounts(val sent: Int = 0, val skipped: Int = 0, val failed: Int = 0)

/** Result of a successful broadcastMessage call. */
data class BroadcastResult(
    val broadcastId: String,
    val recipientCount: Int,
    val perChannel: Map<String, ChannelCounts>,
    /**
     * #823. True when this invocation ran out of budget and handed the rest of
     * the audience to `outboundFanoutSweep`. `recipientCount` is the whole
     * audience either way, so without this the banner reads a half-finished
     * send as a finished one.
     */
    val pending: Boolean = false,
    /** How many households this invocation actually reached. */
    val sent: Int = 0,
)

/**
 * Whole-form readiness for a broadcast. Returns the first blocking reason, or
 * null when the form is ready. Mirrors the server gate: at least one channel; a
 * subject when email or in-app is selected; a non-blank body; an audience
 * (segment or inline criteria, both already non-empty by construction here).
 */
fun broadcastBlocker(
    channels: Set<BroadcastChannel>,
    criteria: BroadcastCriteria,
    subject: String,
    body: String,
): String? {
    if (channels.isEmpty()) return "Pick at least one channel."
    val needsSubject = BroadcastChannel.Email in channels || BroadcastChannel.InApp in channels
    if (needsSubject && subject.trim().isEmpty()) return "Add a subject (it is the title for email and in-app)."
    if (body.trim().isEmpty()) return "Write a message first."
    when (criteria.kind) {
        SegmentKind.All -> Unit
        SegmentKind.Status -> if (criteria.statuses.none { it.isNotBlank() }) return "Choose at least one status for this audience."
        SegmentKind.Tags -> if (criteria.tags.none { it.isNotBlank() }) return "Choose at least one tag for this audience."
    }
    return null
}

/** Readiness for saving a segment: needs a name + a valid (non-empty) criteria. */
fun segmentSaveBlocker(name: String, criteria: BroadcastCriteria): String? {
    if (name.trim().isEmpty()) return "Name this segment first."
    return when (criteria.kind) {
        SegmentKind.All -> null
        SegmentKind.Status -> if (criteria.statuses.none { it.isNotBlank() }) "Choose at least one status." else null
        SegmentKind.Tags -> if (criteria.tags.none { it.isNotBlank() }) "Choose at least one tag." else null
    }
}

// ── JSON codecs ──────────────────────────────────────────────────────────────

private val broadcastJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Serializes criteria to the callable's wire shape. Pure. */
fun criteriaToJson(criteria: BroadcastCriteria): JsonObject = buildJsonObject {
    put("kind", criteria.kind.wire)
    when (criteria.kind) {
        SegmentKind.All -> Unit
        SegmentKind.Status -> put("statuses", buildJsonArray {
            criteria.statuses.filter { it.isNotBlank() }.forEach { add(JsonPrimitive(it.trim())) }
        })
        SegmentKind.Tags -> {
            put("tags", buildJsonArray {
                criteria.tags.filter { it.isNotBlank() }.forEach { add(JsonPrimitive(it.trim())) }
            })
            put("tagMatch", criteria.tagMatch.wire)
        }
    }
}

/** Parses a criteria JSON object back into the model. Pure. Unknown kind -> All. */
fun decodeCriteria(o: JsonObject): BroadcastCriteria {
    val kind = when (o["kind"]?.jsonPrimitive?.contentOrNull) {
        "status" -> SegmentKind.Status
        "tags" -> SegmentKind.Tags
        else -> SegmentKind.All
    }
    val statuses = (o["statuses"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
    val tags = (o["tags"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
    val tagMatch = if (o["tagMatch"]?.jsonPrimitive?.contentOrNull == "all") TagMatch.All else TagMatch.Any
    return BroadcastCriteria(kind = kind, statuses = statuses, tags = tags, tagMatch = tagMatch)
}

/**
 * Decodes the listAudienceSegments body `{ok, segments:[{id,name,criteria,description,updatedAtMs}]}`.
 * Throws on malformed JSON so the caller maps it to a fail-loud error.
 */
fun decodeSegments(dataJson: String): List<AudienceSegment> {
    val o = broadcastJson.parseToJsonElement(dataJson).jsonObject
    val arr = o["segments"] as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val s = el.jsonObject
        val id = s["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        AudienceSegment(
            id = id,
            name = s["name"]?.jsonPrimitive?.contentOrNull ?: "",
            criteria = (s["criteria"] as? JsonObject)?.let { decodeCriteria(it) } ?: BroadcastCriteria(),
            description = s["description"]?.jsonPrimitive?.contentOrNull ?: "",
            updatedAtMs = s["updatedAtMs"]?.jsonPrimitive?.let { it.doubleOrNull?.toLong() } ?: 0L,
        )
    }
}

/**
 * Decodes the broadcastMessage body
 * `{ok, broadcastId, recipientCount, perChannel:{inapp:{sent,skipped,failed},...}}`.
 * Throws on malformed JSON.
 */
fun decodeBroadcastResult(dataJson: String): BroadcastResult {
    val o = broadcastJson.parseToJsonElement(dataJson).jsonObject
    val per = (o["perChannel"] as? JsonObject)?.mapNotNull { (k, v) ->
        val c = v as? JsonObject ?: return@mapNotNull null
        k to ChannelCounts(
            sent = c["sent"]?.jsonPrimitive?.intOrNull ?: 0,
            skipped = c["skipped"]?.jsonPrimitive?.intOrNull ?: 0,
            failed = c["failed"]?.jsonPrimitive?.intOrNull ?: 0,
        )
    }?.toMap() ?: emptyMap()
    return BroadcastResult(
        broadcastId = o["broadcastId"]?.jsonPrimitive?.contentOrNull ?: "",
        recipientCount = o["recipientCount"]?.jsonPrimitive?.intOrNull ?: 0,
        perChannel = per,
        pending = o["pending"]?.jsonPrimitive?.booleanOrNull ?: false,
        sent = o["sent"]?.jsonPrimitive?.intOrNull ?: 0,
    )
}

/**
 * Maps a raw callable error to operator-facing text. The two server sentinels
 * (no_recipients, broadcast_all_failed) get clear copy; everything else passes
 * through verbatim (fail loud, never hide a provider/validation failure).
 */
fun broadcastErrorText(message: String): String = when {
    message.contains("no_recipients", ignoreCase = true) ->
        "That audience has no kinfolk right now. Nothing was sent."
    message.contains("broadcast_all_failed", ignoreCase = true) ->
        "Every send failed. Nothing reached anyone. Check the provider settings and try again."
    // #823's two, from stopBroadcast. Both mean the stop was a no-op and both
    // are good news, so raw sentinel text would read as a failure it is not.
    message.contains("already_finished", ignoreCase = true) ->
        "It had already finished sending, so there was nothing left to stop."
    message.contains("already_stopping", ignoreCase = true) ->
        "A stop is already going through. It finishes within a minute."
    else -> message
}

/**
 * One-line human summary of a broadcast result for the success banner. Pure.
 *
 * #823. A broadcast too large for one invocation comes back part-way through,
 * and `recipientCount` is still the WHOLE audience, so "Reached 900 kinfolk"
 * beside "email: 61 sent" would be an outright false claim about email that
 * has not been sent yet. When the reply says `pending`, the banner says how far
 * it got and who finishes it.
 *
 * This console has no live progress panel, unlike the React admin and Android
 * screens #813 and #816 built. That is deliberate scope: it is the fallback
 * console, and the fix owed to it is an honest sentence, not a second progress
 * language.
 */
fun broadcastSummary(result: BroadcastResult): String {
    val parts = result.perChannel.entries
        .filter { it.value.sent > 0 || it.value.failed > 0 || it.value.skipped > 0 }
        .map { (ch, c) -> "$ch: ${c.sent} sent" + (if (c.skipped > 0) ", ${c.skipped} skipped" else "") + (if (c.failed > 0) ", ${c.failed} failed" else "") }
    val head = if (result.pending) {
        "Still sending: ${result.sent} of ${result.recipientCount} kinfolk so far. It carries on in the background."
    } else {
        "Reached ${result.recipientCount} kinfolk."
    }
    return "$head " + parts.joinToString("; ")
}
