package com.tribetails.auntieos.ui.communicate

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast (Stage 2 step 6): pure criteria model + validation + payload/decode
// helpers. Android parity with web
// (web/.../screens/communicate/Broadcast.kt). All decision logic lives here so
// it is unit-tested at unit-test scope (testDebugUnitTest). The server
// (MyTribe functions/src/admin/{broadcastMessage,audienceSegments}.ts) is the
// source of truth and re-validates everything.
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

/** Audience segment criteria. Mirrors the server CriteriaSchema. */
data class BroadcastCriteria(
    val kind: SegmentKind = SegmentKind.All,
    val statuses: List<String> = emptyList(),
    val tags: List<String> = emptyList(),
    val tagMatch: TagMatch = TagMatch.Any,
) {
    /** Serializes to the callable's wire shape (only fields relevant to [kind]). */
    fun toPayload(): Map<String, Any?> = buildMap {
        put("kind", kind.wire)
        when (kind) {
            SegmentKind.All -> Unit
            SegmentKind.Status -> put("statuses", statuses.map { it.trim() }.filter { it.isNotEmpty() })
            SegmentKind.Tags -> {
                put("tags", tags.map { it.trim() }.filter { it.isNotEmpty() })
                put("tagMatch", tagMatch.wire)
            }
        }
    }
}

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
     * #814. The server recognised this send's `idempotencyKey` and answered from
     * the broadcast an earlier attempt already sent. Nothing left the building
     * on this attempt.
     */
    val deduped: Boolean = false,
    /** #814. That earlier fan-out has not finished, so the counts are a snapshot. */
    val pending: Boolean = false,
)

/**
 * Whole-form readiness for a broadcast. Returns the first blocking reason, or
 * null when ready. Mirrors the server gate. Pure; unit-tested.
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

// ── decode (from Firebase callable Map payloads) ──────────────────────────────

/** Decodes a criteria map (from a segment doc) into the model. Unknown kind -> All. */
@Suppress("UNCHECKED_CAST")
internal fun decodeCriteria(raw: Map<String, Any?>?): BroadcastCriteria {
    if (raw == null) return BroadcastCriteria()
    val kind = when (raw["kind"] as? String) {
        "status" -> SegmentKind.Status
        "tags" -> SegmentKind.Tags
        else -> SegmentKind.All
    }
    val statuses = (raw["statuses"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    val tags = (raw["tags"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
    val tagMatch = if (raw["tagMatch"] as? String == "all") TagMatch.All else TagMatch.Any
    return BroadcastCriteria(kind = kind, statuses = statuses, tags = tags, tagMatch = tagMatch)
}

/** Decodes the listAudienceSegments payload into models. Pure; unit-tested. */
@Suppress("UNCHECKED_CAST")
internal fun decodeSegments(raw: Map<String, Any?>?): List<AudienceSegment> {
    val arr = raw?.get("segments") as? List<*> ?: return emptyList()
    return arr.mapNotNull { el ->
        val s = el as? Map<String, Any?> ?: return@mapNotNull null
        val id = s["id"] as? String ?: return@mapNotNull null
        AudienceSegment(
            id = id,
            name = (s["name"] as? String).orEmpty(),
            criteria = decodeCriteria(s["criteria"] as? Map<String, Any?>),
            description = (s["description"] as? String).orEmpty(),
            updatedAtMs = (s["updatedAtMs"] as? Number)?.toLong() ?: 0L,
        )
    }
}

/** Decodes the broadcastMessage payload into a [BroadcastResult]. Pure; unit-tested. */
@Suppress("UNCHECKED_CAST")
internal fun decodeBroadcastResult(raw: Map<String, Any?>?): BroadcastResult {
    val per = (raw?.get("perChannel") as? Map<String, Any?>)?.mapNotNull { (k, v) ->
        val c = v as? Map<String, Any?> ?: return@mapNotNull null
        k to ChannelCounts(
            sent = (c["sent"] as? Number)?.toInt() ?: 0,
            skipped = (c["skipped"] as? Number)?.toInt() ?: 0,
            failed = (c["failed"] as? Number)?.toInt() ?: 0,
        )
    }?.toMap() ?: emptyMap()
    return BroadcastResult(
        broadcastId = (raw?.get("broadcastId") as? String).orEmpty(),
        recipientCount = (raw?.get("recipientCount") as? Number)?.toInt() ?: 0,
        perChannel = per,
        // `== true`, so a backend older than these fields reads as false rather
        // than as an unknown some branch might take for true.
        deduped = raw?.get("deduped") == true,
        pending = raw?.get("pending") == true,
    )
}

/** Decodes the saved-segment id from saveAudienceSegment. Pure. */
internal fun decodeSavedSegmentId(raw: Map<String, Any?>?): String = (raw?.get("id") as? String).orEmpty()

/** Maps a raw callable error to operator-facing text (server sentinels + passthrough). */
fun broadcastErrorText(message: String): String = when {
    message.contains("no_recipients", ignoreCase = true) ->
        "That audience has no kinfolk right now. Nothing was sent."
    message.contains("broadcast_all_failed", ignoreCase = true) ->
        "Every send failed. Nothing reached anyone. Check the provider settings and try again."
    else -> message
}

/** One-line human summary of a broadcast result. Pure. */
fun broadcastSummary(result: BroadcastResult): String {
    // #814: a deduped reply describes a broadcast an EARLIER attempt sent, so it
    // must not be read as this press having sent one.
    if (result.deduped && result.pending) {
        return "You already sent this message, and it is still going out. Nothing went out twice."
    }
    if (result.deduped) return "You already sent this message. Nothing went out twice."
    val parts = result.perChannel.entries
        .filter { it.value.sent > 0 || it.value.failed > 0 || it.value.skipped > 0 }
        .map { (ch, c) -> "$ch: ${c.sent} sent" + (if (c.skipped > 0) ", ${c.skipped} skipped" else "") + (if (c.failed > 0) ", ${c.failed} failed" else "") }
    return "Reached ${result.recipientCount} kinfolk. " + parts.joinToString("; ")
}
