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
)

/** Decodes the scheduleMarketingBlast payload. Pure; unit-tested. */
fun decodeScheduleResult(raw: Map<String, Any?>?): ScheduleBlastResult = ScheduleBlastResult(
    blastId = (raw?.get("blastId") as? String).orEmpty(),
    matched = (raw?.get("matched") as? Number)?.toInt() ?: 0,
    noLinkedAccount = (raw?.get("noLinkedAccount") as? Number)?.toInt() ?: 0,
    dispatched = (raw?.get("dispatched") as? Number)?.toInt() ?: 0,
    suppressed = (raw?.get("suppressed") as? Number)?.toInt() ?: 0,
    failed = (raw?.get("failed") as? Number)?.toInt() ?: 0,
)

/** One-line summary of what a schedule actually did. Pure. */
fun scheduleSummary(result: ScheduleBlastResult): String {
    val tail = if (result.failed > 0) ", ${result.failed} failed" else ""
    return "${result.dispatched} queued, ${result.suppressed} suppressed$tail."
}

// ── campaign list ────────────────────────────────────────────────────────────

enum class BlastStatus(val wire: String, val label: String) {
    Scheduled("scheduled", "Scheduled"),
    Sent("sent", "Sent"),
    Cancelled("cancelled", "Cancelled"),
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
) {
    /** What the row is called in the list. The key is the fallback for an unnamed campaign. */
    val displayName: String get() = title.ifBlank { key }
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
        )
    }.sortedByDescending { it.fireAtMs }
}

/** Decodes how many queued notifications a cancel removed. Pure. */
fun decodeCancelledCount(raw: Map<String, Any?>?): Int = (raw?.get("cancelled") as? Number)?.toInt() ?: 0

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
