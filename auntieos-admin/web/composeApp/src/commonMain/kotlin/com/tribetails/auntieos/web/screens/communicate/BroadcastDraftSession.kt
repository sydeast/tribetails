package com.tribetails.auntieos.web.screens.communicate

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * #867 re-review: the broadcast being written, and what protects it from being sent
 * twice. It lived in `remember` inside the Broadcast form, which only exists while
 * Broadcast mode is open, so switching to Personalize or leaving Communicate threw
 * away the draft, its idempotency key and the timeout marker. Retyping the message
 * after that minted a new key and could send a second broadcast, which made "Press
 * Send again without changing anything" impossible to follow.
 *
 * [BroadcastDraftSession] keeps one for the signed-in session. App clears it on
 * sign-out.
 */
@Stable
class BroadcastDraft {
    var selectedSegmentId by mutableStateOf<String?>(null)
    var kind by mutableStateOf(SegmentKind.All)
    var statusesText by mutableStateOf("")
    var selectedTags by mutableStateOf<List<String>>(emptyList())
    var tagMatch by mutableStateOf(TagMatch.Any)
    val channels = mutableStateListOf(BroadcastChannel.InApp)
    var subject by mutableStateOf("")
    var body by mutableStateOf("")

    /** #814: one key per submission; see `CommunicateScreen.send`. */
    var submissionKey by mutableStateOf<String?>(null)
    var submissionSignature by mutableStateOf<String?>(null)

    /** The signature of a draft whose send timed out (or was found still running), or null. */
    var timedOutSignature by mutableStateOf<String?>(null)
    var errorText by mutableStateOf<String?>(null)
    var errorIsTimeout by mutableStateOf(false)

    /** Whether this session already looked for a broadcast still running from before it. */
    var checkedForRunningBroadcast by mutableStateOf(false)

    fun signature(): String =
        broadcastSignature(selectedSegmentId, kind, statusesText, selectedTags, tagMatch, channels, subject, body)

    /**
     * Puts a broadcast that is still sending back on the form, with its own key, so
     * an unchanged Send replays onto it (the server answers from the row it already
     * claimed) instead of minting a new key and starting a second broadcast.
     */
    fun restoreRunning(row: RunningBroadcast) {
        selectedSegmentId = row.segmentId
        val criteria = row.criteria ?: BroadcastCriteria()
        kind = criteria.kind
        statusesText = criteria.statuses.joinToString(", ")
        selectedTags = criteria.tags
        tagMatch = criteria.tagMatch
        channels.clear()
        channels.addAll(row.channels)
        subject = row.subject.orEmpty()
        body = row.body
        submissionKey = row.id
        submissionSignature = signature()
        timedOutSignature = submissionSignature
        errorText = runningBroadcastNotice(row.subject)
        errorIsTimeout = true
    }
}

/** The draft for this signed-in session. */
object BroadcastDraftSession {
    var current: BroadcastDraft by mutableStateOf(BroadcastDraft())
        private set

    /** Called on sign-out, and by tests between cases. */
    fun clear() {
        current = BroadcastDraft()
    }
}

/** A `broadcasts/{id}` row this admin started that the server is still sending. */
data class RunningBroadcast(
    val id: String,
    val subject: String?,
    val body: String,
    val channels: List<BroadcastChannel>,
    val segmentId: String?,
    val criteria: BroadcastCriteria?,
    val sentAtMs: Long,
)

/**
 * How far back a still-running row counts. `broadcastMessage` declares
 * `timeoutSeconds: 540`, and a cold start and the fan-out sweep's first pass add to
 * that, so 15 minutes covers a send whose request timed out on this console.
 */
const val RUNNING_BROADCAST_WINDOW_MS: Long = 15 * 60_000L

/**
 * Pure: the rows (flat JSON, `_id` plus fields, as the REST layer returns them) that
 * are still sending and started within [windowMs] of [nowMs], newest first. A row
 * with no stored body or no channel this console knows cannot be replayed from the
 * form, so it is left out.
 */
fun decodeRunningBroadcasts(rows: List<JsonObject>, nowMs: Long, windowMs: Long = RUNNING_BROADCAST_WINDOW_MS): List<RunningBroadcast> =
    rows.mapNotNull { row ->
        if (row["fanoutState"]?.jsonPrimitive?.contentOrNull != "running") return@mapNotNull null
        val sentAtMs = row["sentAtMs"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
        if (sentAtMs < nowMs - windowMs) return@mapNotNull null
        val id = row["_id"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val body = row["body"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val channels = (row["channels"] as? JsonArray).orEmpty()
            .mapNotNull { el -> BroadcastChannel.values().firstOrNull { it.wire == el.jsonPrimitive.contentOrNull } }
        if (channels.isEmpty()) return@mapNotNull null
        RunningBroadcast(
            id = id,
            subject = row["subject"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() },
            body = body,
            channels = channels,
            segmentId = row["segmentId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() },
            criteria = (row["criteria"] as? JsonObject)?.let { decodeCriteria(it) },
            sentAtMs = sentAtMs,
        )
    }.sortedByDescending { it.sentAtMs }

/** What the form says about a broadcast it found still sending. */
fun runningBroadcastNotice(subject: String?): String =
    if (subject.isNullOrBlank()) {
        "Your last broadcast may still be sending. Press Send again without changing anything to see its status."
    } else {
        "\"$subject\" may still be sending. Press Send again without changing anything to see its status."
    }
