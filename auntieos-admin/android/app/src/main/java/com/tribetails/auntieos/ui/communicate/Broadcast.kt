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
    /**
     * #814. The fan-out has not finished, so the counts are a snapshot.
     *
     * #823 made this the ORDINARY reply for any audience past about sixty
     * households: `broadcastMessage` sends for fifteen seconds and a cron sweep
     * carries the rest, because five thousand households cannot be reached
     * inside a function's 540-second ceiling.
     */
    val pending: Boolean = false,
    /** #823. Households the send has reached a verdict on, out of [audienceSize]. */
    val sent: Int = 0,
    /** #823. The frozen roster's size. */
    val audienceSize: Int = 0,
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
        sent = (raw?.get("sent") as? Number)?.toInt() ?: 0,
        audienceSize = (raw?.get("audienceSize") as? Number)?.toInt() ?: 0,
    )
}

// ── #823: a broadcast whose fan-out outlived its call ────────────────────────
/** How a broadcast's fan-out is doing. */
enum class BroadcastFanoutState(val wire: String) {
    Running("running"),
    /** Running with a long-dead lease: a send that stopped moving. */
    Stalled("stalled"),
    Complete("complete"),
    Failed("failed"),
    Cancelled("cancelled"),
    ;
    companion object {
        /**
         * An unknown state, and a missing one, read as [Complete]. A send from a
         * backend that does not report progress is not in flight, and a progress
         * bar that could never move would be worse than none.
         */
        fun fromWire(wire: String?): BroadcastFanoutState =
            entries.firstOrNull { it.wire == wire } ?: Complete
    }
}
data class BroadcastProgress(
    val broadcastId: String = "",
    val fanoutState: BroadcastFanoutState = BroadcastFanoutState.Complete,
    /** Households the send has reached a verdict on. */
    val sent: Int = 0,
    /** The frozen roster's size. */
    val audienceSize: Int = 0,
    /** Households that received it on at least one channel. */
    val reached: Int = 0,
    /** Households whose channels all resolved OFF, so nothing was attempted. */
    val suppressedByPrefs: Int = 0,
    /** True when a stop has been asked for and the fan-out has not confirmed it. */
    val stopRequested: Boolean = false,
) {
    /** True while there is still something to watch, and something to stop. */
    val running: Boolean
        get() = fanoutState == BroadcastFanoutState.Running || fanoutState == BroadcastFanoutState.Stalled
    /** 0f..1f for the progress bar, or 0f when the roster size is unknown. */
    val progress: Float get() = if (audienceSize > 0) sent.toFloat() / audienceSize else 0f
}
/** Decodes the getBroadcastProgress payload. Pure. */
fun decodeBroadcastProgress(broadcastId: String, raw: Map<String, Any?>?): BroadcastProgress = BroadcastProgress(
    broadcastId = broadcastId,
    fanoutState = BroadcastFanoutState.fromWire(raw?.get("fanoutState") as? String),
    sent = (raw?.get("sent") as? Number)?.toInt() ?: 0,
    audienceSize = (raw?.get("audienceSize") as? Number)?.toInt() ?: 0,
    reached = (raw?.get("reached") as? Number)?.toInt() ?: 0,
    suppressedByPrefs = (raw?.get("suppressedByPrefs") as? Number)?.toInt() ?: 0,
    stopRequested = raw?.get("stopRequested") == true,
)
data class StopBroadcastResult(
    /** Households already contacted. Nothing here can be recalled. */
    val sent: Int = 0,
    /** Households the roster still held. These will not be contacted. */
    val neverSent: Int = 0,
)
/** Decodes the stopBroadcast payload. Pure. */
fun decodeStopBroadcastResult(raw: Map<String, Any?>?): StopBroadcastResult = StopBroadcastResult(
    sent = (raw?.get("sent") as? Number)?.toInt() ?: 0,
    neverSent = (raw?.get("neverSent") as? Number)?.toInt() ?: 0,
)
/**
 * What the operator is told after stopping a send part-way. Pure.
 *
 * Counts rather than a word, because "stopped" on its own would invite the
 * reading that nothing went out. Mirrors the sentence
 * `auntieos-admin/src/screens/CommunicateCompose.tsx` renders.
 */
fun stopBroadcastNotice(result: StopBroadcastResult): String {
    val have = if (result.sent == 1) "household has" else "households have"
    return "Stopping. ${result.sent} $have already been contacted and cannot be called back. " +
        "${result.neverSent} will not be."
}
/** The still-sending line: how far a broadcast has got, or that it stopped moving. Pure. */
fun broadcastSendingLabel(progress: BroadcastProgress): String = when {
    !progress.running -> "Finished. ${progress.sent} of ${progress.audienceSize} households."
    progress.fanoutState == BroadcastFanoutState.Stalled ->
        "Stopped at ${progress.sent} of ${progress.audienceSize} households. It picks up again within a minute."
    else -> "${progress.sent} of ${progress.audienceSize} households so far."
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
