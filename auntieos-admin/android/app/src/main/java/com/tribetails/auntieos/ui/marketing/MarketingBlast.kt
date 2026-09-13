package com.tribetails.auntieos.ui.marketing

import com.tribetails.auntieos.ui.communicate.BroadcastCriteria
import com.tribetails.auntieos.ui.communicate.SegmentKind
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// ─────────────────────────────────────────────────────────────────────────────
// Marketing blasts: pure model + payload/decode + validation. Android parity
// with the React admin (auntieos-admin/src/api/marketingBlasts.ts and
// src/lib/marketingBlastEdit.ts). Every decision lives here so it runs at
// unit-test scope (testDebugUnitTest). The server
// (MyTribe functions/src/admin/{scheduleMarketingBlast,marketingBlasts}.ts) is
// the source of truth and re-validates everything.
//
// The audience model is NOT redefined here: BroadcastCriteria / SegmentKind /
// TagMatch come from ui/communicate/Broadcast.kt, because a blast and a
// broadcast speak the same server CriteriaSchema. A second copy would be two
// answers to one question.
// ─────────────────────────────────────────────────────────────────────────────

/** The three marketing catalog rows `scheduleMarketingBlast` accepts. */
enum class MarketingKey(val wire: String, val label: String) {
    Newsletter("newsletter.announcement", "Newsletter"),
    Survey("survey.event", "Survey or event"),
    OptIn("marketing.optin", "Opt-in nudge"),
    ;

    companion object {
        fun fromWire(wire: String?): MarketingKey? = entries.firstOrNull { it.wire == wire }
    }
}

/** Which of the three audience paths the form is on. Exactly one goes on the wire. */
enum class AudienceMode { Criteria, Segment, Uids }

/**
 * The audience half of a blast payload. One of three, never two: the server's
 * superRefine refuses a payload carrying more than one, because the handler
 * would otherwise have to pick and handler precedence is not something an
 * operator can see.
 */
sealed interface BlastAudience {
    data class Segment(val segmentId: String) : BlastAudience
    data class Criteria(val criteria: BroadcastCriteria) : BlastAudience
    data class Uids(val uids: List<String>) : BlastAudience

    fun toPayload(): Map<String, Any?> = when (this) {
        is Segment -> mapOf("segmentId" to segmentId)
        is Criteria -> mapOf("criteria" to criteria.toPayload())
        is Uids -> mapOf("audienceUids" to uids)
    }
}

/**
 * Builds the audience the form currently describes, or null when it does not
 * describe one yet.
 *
 * Null is the honest "not ready". It is never a `SegmentKind.All` fallback,
 * which on a marketing send would silently reach every household on the roster.
 */
fun blastAudience(
    mode: AudienceMode,
    selectedSegmentId: String?,
    criteria: BroadcastCriteria,
    uids: List<String>,
): BlastAudience? = when (mode) {
    AudienceMode.Segment -> selectedSegmentId?.takeIf { it.isNotBlank() }?.let { BlastAudience.Segment(it) }
    AudienceMode.Uids -> uids.takeIf { it.isNotEmpty() }?.let { BlastAudience.Uids(it) }
    AudienceMode.Criteria -> when (criteria.kind) {
        SegmentKind.All -> BlastAudience.Criteria(criteria)
        SegmentKind.Status ->
            if (criteria.statuses.any { it.isNotBlank() }) BlastAudience.Criteria(criteria) else null
        SegmentKind.Tags ->
            if (criteria.tags.any { it.isNotBlank() }) BlastAudience.Criteria(criteria) else null
    }
}

/**
 * Splits a pasted account list on commas, whitespace and newlines, de-duped.
 *
 * Newlines because the realistic way 200 uids get into the box is a paste out of
 * a spreadsheet column, and a comma-only split turns that into one enormous uid
 * the server then rejects as a single unknown account.
 */
fun parseUidList(raw: String): List<String> {
    val out = LinkedHashSet<String>()
    for (part in raw.split(',', ' ', '\n', '\t', '\r')) {
        val uid = part.trim()
        if (uid.isNotEmpty()) out.add(uid)
    }
    return out.toList()
}

private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE

/**
 * Resolves the `yyyy-MM-dd` + `HH:mm` pair to epoch millis, or null when either
 * is blank or the pair is not a real instant.
 *
 * Resolved in the DEVICE's zone, because the operator picked a wall-clock time
 * in their own day; reading it as UTC would silently move a 9am send by however
 * many hours their offset is. [zone] is a parameter so the test can pin one.
 */
fun fireAtMsFrom(date: String, time: String, zone: ZoneId = ZoneId.systemDefault()): Long? {
    if (date.isBlank() || time.isBlank()) return null
    return runCatching {
        val d = LocalDate.parse(date.trim(), DATE_FMT)
        val t = LocalTime.parse(time.trim())
        d.atTime(t).atZone(zone).toInstant().toEpochMilli()
    }.getOrNull()
}

/**
 * Turns the merge-field rows into the `data` record the callable takes.
 *
 * A row with a blank key is dropped rather than written as `""`: an empty token
 * name matches no `{{token}}` in any template, so keeping it would put a field
 * in the audit payload that can never render. A later row with the same key
 * wins, which is what the last thing the operator typed should do.
 */
data class MergeFieldRow(val key: String = "", val value: String = "")

fun mergeFieldsToData(rows: List<MergeFieldRow>): Map<String, Any?> {
    val out = LinkedHashMap<String, Any?>()
    for (row in rows) {
        val key = row.key.trim()
        if (key.isEmpty()) continue
        out[key] = row.value
    }
    return out
}

/**
 * Why this blast cannot be scheduled yet, or null when it can. First blocking
 * reason wins, so the operator is told one thing to fix rather than four.
 *
 * [reachable] is the PREVIEW's count and is deliberately nullable: a blast is
 * schedulable without previewing first (the server does the same resolve and
 * refuses `no_recipients` itself), but once a preview has come back saying it
 * reaches nobody, sending anyway is a round trip whose only outcome is an error.
 * Null means "not previewed", which is not the same as zero.
 */
fun blastBlocker(
    audience: BlastAudience?,
    fireAtMs: Long?,
    nowMs: Long,
    reachable: Int?,
): String? {
    if (audience == null) return "Choose an audience first."
    if (fireAtMs == null) return "Pick a date and a time to send."
    // The server's own window: anything more than a minute in the past is refused.
    if (fireAtMs < nowMs - 60_000L) return "That send time has already passed."
    if (reachable == 0) return "This audience reaches nobody. Widen it, or check who has opted in."
    return null
}

// ── preview ──────────────────────────────────────────────────────────────────

/**
 * What `previewMarketingBlastAudience` returns: four counted facts, not one
 * number with three caveats. [suppressedByPrefs] is computed server-side with
 * the dispatcher's own channel resolution, so this predicts the send rather
 * than estimating it.
 */
data class BlastReach(
    val description: String = "",
    val matched: Int = 0,
    val noLinkedAccount: Int = 0,
    val suppressedByPrefs: Int = 0,
    val reachable: Int = 0,
)

/** Decodes the preview payload. Pure; unit-tested. */
fun decodeBlastReach(raw: Map<String, Any?>?): BlastReach = BlastReach(
    description = (raw?.get("description") as? String).orEmpty(),
    matched = (raw?.get("matched") as? Number)?.toInt() ?: 0,
    noLinkedAccount = (raw?.get("noLinkedAccount") as? Number)?.toInt() ?: 0,
    suppressedByPrefs = (raw?.get("suppressedByPrefs") as? Number)?.toInt() ?: 0,
    reachable = (raw?.get("reachable") as? Number)?.toInt() ?: 0,
)

// ── schedule result ──────────────────────────────────────────────────────────

data class ScheduleBlastResult(
    val blastId: String = "",
    val matched: Int = 0,
    val noLinkedAccount: Int = 0,
    val dispatched: Int = 0,
    val suppressed: Int = 0,
    val failed: Int = 0,
    /**
     * #814. The blast already existed: this attempt carried an `idempotencyKey`
     * the server had already seen, so nothing was queued a second time.
     */
    val deduped: Boolean = false,
    /**
     * #814. The fan-out has not finished, so the counts above are a snapshot
     * rather than a total.
     *
     * #823 made this the ORDINARY reply for any audience past about sixty
     * households. `scheduleMarketingBlast` queues for fifteen seconds and hands
     * the rest to a cron sweep, because five thousand recipients at five to six
     * Firestore round trips each cannot finish inside a function's 540-second
     * ceiling.
     */
    val pending: Boolean = false,
    /** #823. Recipients accounted for so far, out of [audienceSize]. */
    val queued: Int = 0,
    /** #823. The frozen roster's size: everyone this campaign will reach. */
    val audienceSize: Int = 0,
)

/** Decodes the scheduleMarketingBlast payload. Pure; unit-tested. */
fun decodeScheduleResult(raw: Map<String, Any?>?): ScheduleBlastResult = ScheduleBlastResult(
    blastId = (raw?.get("blastId") as? String).orEmpty(),
    matched = (raw?.get("matched") as? Number)?.toInt() ?: 0,
    noLinkedAccount = (raw?.get("noLinkedAccount") as? Number)?.toInt() ?: 0,
    dispatched = (raw?.get("dispatched") as? Number)?.toInt() ?: 0,
    suppressed = (raw?.get("suppressed") as? Number)?.toInt() ?: 0,
    failed = (raw?.get("failed") as? Number)?.toInt() ?: 0,
    // `== true`, so a backend older than these fields reads as false rather than
    // as an unknown that some other branch might treat as true.
    deduped = raw?.get("deduped") == true,
    pending = raw?.get("pending") == true,
    queued = (raw?.get("queued") as? Number)?.toInt() ?: 0,
    audienceSize = (raw?.get("audienceSize") as? Number)?.toInt() ?: 0,
)

/** One-line summary of what a schedule actually did. Pure. */
fun scheduleSummary(result: ScheduleBlastResult): String {
    val tail = if (result.failed > 0) ", ${result.failed} failed" else ""
    return "${result.dispatched} queued, ${result.suppressed} suppressed$tail."
}
/**
 * What the operator is told after pressing Schedule (#814). Pure.
 *
 * Three outcomes, and they are three different facts:
 *
 *   a fresh blast    the counts, as before.
 *   a deduped reply  this press landed on a blast an earlier attempt already
 *                    made. Saying "Scheduled" again would tell the operator
 *                    they had just sent a second campaign, which is precisely
 *                    what the key prevented.
 *   still queueing   the first attempt is mid fan-out, so the stored counts are
 *                    a snapshot. Reporting them as a total would be a confident
 *                    wrong number, so they are left out and the campaign list is
 *                    where the final ones show up.
 *
 * Mirrors `auntieos-admin/src/lib/marketingBlastEdit.ts#scheduleNotice`.
 */
fun scheduleNotice(result: ScheduleBlastResult, whenLabel: String): String {
    if (result.deduped && result.pending) {
        return "You already scheduled this campaign for $whenLabel, and it is still queueing. " +
            "Nothing went out twice. The campaign list has the counts once it finishes."
    }
    if (result.deduped) {
        return "You already scheduled this campaign for $whenLabel. Nothing went out twice. " +
            scheduleSummary(result)
    }
    if (result.pending) {
        // #823, and now the ordinary outcome past about sixty households. The
        // counts describe one leg of the send; reporting them as the whole thing
        // would be true of this second and wrong of the next.
        return "Scheduled for $whenLabel. Still queueing: ${result.queued} of ${result.audienceSize} " +
            "so far. It carries on in the background."
    }
    return "Scheduled for $whenLabel. " + scheduleSummary(result)
}
/**
 * The progress line on a campaign that is still being queued: the mock's "256 of
 * 410 dispatched", drawn from numbers the row can back. Pure.
 *
 * A STALLED fan-out is named rather than dressed up as a slow one. Its lease has
 * been gone for two sweep ticks with nothing moving, and an operator told "still
 * sending" about a campaign that stopped twenty minutes ago has been misled by a
 * progress bar.
 *
 * Mirrors `auntieos-admin/src/lib/marketingBlastEdit.ts#sendingLabel`.
 */
fun sendingLabel(queued: Int, audienceSize: Int, stalled: Boolean): String {
    val of = if (audienceSize > 0) "$queued of $audienceSize" else "$queued"
    return if (stalled) "Stopped at $of queued. It picks up again within a minute." else "$of queued"
}
/**
 * What a cancel actually achieved, in the operator's terms. Pure.
 *
 * A cancel that lands MID fan-out cannot prove the worker stopped, so it does
 * not claim to have. The campaign reads Cancelling until the sweep confirms it,
 * and this sentence says the same thing rather than announcing a finality the
 * server refused to write down.
 *
 * Mirrors `auntieos-admin/src/lib/marketingBlastEdit.ts#cancelNotice`.
 */
fun cancelNotice(result: CancelBlastResult): String {
    val word = if (result.cancelled == 1) "notification" else "notifications"
    val removed = "${result.cancelled} queued $word removed"
    if (result.stopped) return "Cancelled. $removed."
    return "Stopping. $removed, and ${result.neverQueued} were never queued. " +
        "It finishes stopping within a minute."
}

// ── campaign list ────────────────────────────────────────────────────────────

/**
 * #823 added three. [Sending] is a campaign whose fan-out is still walking its
 * roster, [Cancelling] one whose stop has been asked for and not yet confirmed,
 * and [Failed] one whose fan-out never armed, so nothing was queued and nothing
 * ever will be.
 */
enum class BlastStatus(val wire: String, val label: String) {
    Scheduled("scheduled", "Scheduled"),
    Sending("sending", "Sending"),
    Sent("sent", "Sent"),
    Cancelling("cancelling", "Cancelling"),
    Cancelled("cancelled", "Cancelled"),
    Failed("failed", "Failed"),
    ;

    companion object {
        /**
         * An unknown status from a future deploy reads as Scheduled, which is the
         * one that still offers Cancel, so the operator keeps a way to act on a
         * row this build does not understand.
         */
        fun fromWire(wire: String?): BlastStatus =
            entries.firstOrNull { it.wire == wire } ?: Scheduled
    }
}

/** #823. How the fan-out itself is doing, beside the campaign's own status. */
enum class BlastFanoutState(val wire: String) {
    Running("running"),
    /** Running with a long-dead lease: queueing that stopped moving. */
    Stalled("stalled"),
    Complete("complete"),
    Failed("failed"),
    Cancelled("cancelled"),
    ;
    companion object {
        /**
         * An unknown state, and a missing one, read as [Complete]. A campaign
         * from a backend that does not report progress is not in flight, and a
         * progress bar that could never move would be worse than none.
         */
        fun fromWire(wire: String?): BlastFanoutState =
            entries.firstOrNull { it.wire == wire } ?: Complete
    }
}
data class MarketingBlastRow(
    val id: String,
    val key: String,
    val title: String,
    val fireAtMs: Long,
    val status: BlastStatus,
    val audienceDescription: String,
    val matched: Int,
    val noLinkedAccount: Int,
    val dispatched: Int,
    val suppressed: Int,
    val failed: Int,
    /** #823. `Stalled` is running with a long-dead lease. */
    val fanoutState: BlastFanoutState = BlastFanoutState.Complete,
    /** #823. Recipients accounted for, out of [audienceSize]. */
    val queued: Int = 0,
    /** #823. The frozen roster's size. 0 on a campaign written before this shipped. */
    val audienceSize: Int = 0,
) {
    /** What the row is called in the list. The key is the fallback for an unnamed campaign. */
    val displayName: String get() = title.ifBlank { key }
    /** 0f..1f for the mock's Sending bar, or 0f when the roster size is unknown. */
    val progress: Float get() = if (audienceSize > 0) queued.toFloat() / audienceSize else 0f
}

/**
 * Decodes the listMarketingBlasts payload, newest fire time first.
 *
 * A row with no id is dropped: it could never be cancelled, so rendering a
 * Cancel button beside it would be a button that cannot work.
 */
@Suppress("UNCHECKED_CAST")
fun decodeBlasts(raw: Map<String, Any?>?): List<MarketingBlastRow> {
    val arr = raw?.get("blasts") as? List<*> ?: return emptyList()
    return arr.mapNotNull { el ->
        val b = el as? Map<String, Any?> ?: return@mapNotNull null
        val id = (b["id"] as? String)?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        MarketingBlastRow(
            id = id,
            key = (b["key"] as? String).orEmpty(),
            title = (b["title"] as? String).orEmpty(),
            fireAtMs = (b["fireAtMs"] as? Number)?.toLong() ?: 0L,
            status = BlastStatus.fromWire(b["status"] as? String),
            audienceDescription = (b["audienceDescription"] as? String).orEmpty(),
            matched = (b["matched"] as? Number)?.toInt() ?: 0,
            noLinkedAccount = (b["noLinkedAccount"] as? Number)?.toInt() ?: 0,
            dispatched = (b["dispatched"] as? Number)?.toInt() ?: 0,
            suppressed = (b["suppressed"] as? Number)?.toInt() ?: 0,
            failed = (b["failed"] as? Number)?.toInt() ?: 0,
            fanoutState = BlastFanoutState.fromWire(b["fanoutState"] as? String),
            queued = (b["queued"] as? Number)?.toInt() ?: 0,
            audienceSize = (b["audienceSize"] as? Number)?.toInt() ?: 0,
        )
    }.sortedByDescending { it.fireAtMs }
}

/**
 * What a cancel achieved (#823).
 *
 * [stopped] is false when the blast was still being queued, so the fan-out was
 * ASKED to stop rather than proven to have stopped; the sweep confirms it within
 * a minute and the campaign reads Cancelling until it does.
 */
data class CancelBlastResult(
    val cancelled: Int = 0,
    val stopped: Boolean = true,
    val neverQueued: Int = 0,
)
/** Decodes the cancelMarketingBlast payload. Pure. */
fun decodeCancelResult(raw: Map<String, Any?>?): CancelBlastResult = CancelBlastResult(
    cancelled = (raw?.get("cancelled") as? Number)?.toInt() ?: 0,
    // `!= false` rather than `== true`: a backend older than #823 sends neither
    // field and really did finish the cancel synchronously, so the honest
    // reading for it is "stopped".
    stopped = raw?.get("stopped") != false,
    neverQueued = (raw?.get("neverQueued") as? Number)?.toInt() ?: 0,
)

/** Maps a raw callable error to operator-facing text (server sentinels + passthrough). */
fun blastErrorText(message: String): String = when {
    message.contains("no_recipients", ignoreCase = true) ->
        "That audience has nobody with a MyTribe account right now. Nothing was scheduled."
    message.contains("audience_too_large", ignoreCase = true) ->
        "That audience is over the 5000 recipient limit for one blast. Narrow it and try again."
    message.contains("already_fired", ignoreCase = true) ->
        "That blast has already gone out. It cannot be called back."
    message.contains("already_cancelled", ignoreCase = true) ->
        "That blast was already cancelled."
    else -> message
}

/** Local `yyyy-MM-dd HH:mm` for a fire time, or a blank marker. Pure; zone-injectable for the test. */
fun fireLabel(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    if (ms <= 0L) return "no send time"
    return runCatching {
        java.time.Instant.ofEpochMilli(ms).atZone(zone).toLocalDateTime()
            .format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))
    }.getOrDefault("no send time")
}
