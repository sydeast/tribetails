package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.CallLog
import com.tribetails.auntieos.web.data.EmailMessage
import com.tribetails.auntieos.web.data.SmsMessage
import com.tribetails.auntieos.web.data.VoicemailLog
import com.tribetails.auntieos.web.screens.cutWhole
import kotlinx.datetime.toLocalDateTime

/**
 * Pure helpers for the Communicate recipient-context panel. No Compose, no IO —
 * unit-tested in commonTest. Duplicated verbatim on android (separate codebase).
 */

/** tldr if non-blank; else rawSummary truncated to [max] with an ellipsis; else "". */
fun summaryLine(tldr: String, rawSummary: String, max: Int): String {
    val t = tldr.trim()
    if (t.isNotEmpty()) return t
    val r = rawSummary.trim()
    if (r.isEmpty()) return ""
    if (max <= 0 || r.length <= max) return r
    return cutWhole(r, max).trimEnd() + "…"
}

/**
 * #1878: the newest message of the household's thread with the office. It lives
 * apart from the four logs, so a household could have a full thread and read
 * "No messages on file yet." [preview] is one plain line from the server.
 */
data class LatestThreadMessage(val preview: String, val createdAtMs: Long)

/** The channel word on the Latest message line. Never the stored key. Pure. */
fun commsChannelLabel(channel: String): String = when (channel) {
    "sms" -> "Text"
    "email" -> "Email"
    "call" -> "Call"
    "voicemail" -> "Voicemail"
    "thread" -> "MyTribe message"
    else -> "Message"
}

/**
 * #1878: a stored instant as a local YYYY-MM-DD, so an evening message reads the
 * day the Inbox shows it on, never the next UTC day. Anything else is returned as it is.
 */
@OptIn(kotlin.time.ExperimentalTime::class)
fun commsLocalDay(
    timestamp: String,
    zone: kotlinx.datetime.TimeZone = kotlinx.datetime.TimeZone.currentSystemDefault(),
): String {
    if ('T' !in timestamp) return timestamp
    return runCatching {
        kotlin.time.Instant.parse(timestamp.trim()).toLocalDateTime(zone).date.toString()
    }.getOrDefault(timestamp)
}

data class LatestComm(
    val channel: String,   // "sms" | "email" | "call" | "voicemail"
    val timestamp: String, // ISO-8601 UTC string
    val snippet: String,
)

private fun commSnippet(text: String, max: Int = 140): String {
    val t = text.trim()
    return if (t.length <= max) t else cutWhole(t, max).trimEnd() + "…"
}

/**
 * The single most recent record across the four comms lists, by ISO timestamp
 * (lexicographic compare — same UTC format sorts correctly). Entries with a
 * blank timestamp are ignored. null if nothing qualifies.
 */
@OptIn(kotlin.time.ExperimentalTime::class)
fun latestCommunication(
    sms: List<SmsMessage>,
    emails: List<EmailMessage>,
    calls: List<CallLog>,
    voicemails: List<VoicemailLog>,
    thread: LatestThreadMessage? = null,
): LatestComm? {
    val candidates = buildList {
        sms.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("sms", it.timestamp, commSnippet(it.body))) }
        emails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("email", it.timestamp, commSnippet(it.subject.ifBlank { it.body }))) }
        calls.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("call", it.timestamp, commSnippet(it.transcript.ifBlank { it.status }))) }
        voicemails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("voicemail", it.timestamp, commSnippet(it.transcript))) }
        thread?.takeIf { it.createdAtMs > 0 }?.let {
            add(LatestComm("thread", kotlin.time.Instant.fromEpochMilliseconds(it.createdAtMs).toString(), commSnippet(it.preview)))
        }
    }
    return candidates.maxByOrNull { it.timestamp }
}

sealed class CommsBoxState {
    data class AiRecap(val recap: String) : CommsBoxState()
    data class RawLatest(val latest: LatestComm, val disclosedFallback: Boolean) : CommsBoxState()
    data object Empty : CommsBoxState()
}

/**
 * Which comms-box variant to render. Encodes the disclosed-fallback rule:
 * - flag on + non-blank recap -> AiRecap
 * - else if a latest record exists -> RawLatest (disclosedFallback = flagOn: a
 *   note is shown only when the flag is on but we fell back to raw)
 * - else -> Empty
 */
fun commsBoxState(flagOn: Boolean, recap: String?, latest: LatestComm?): CommsBoxState {
    val r = recap?.trim().orEmpty()
    if (flagOn && r.isNotEmpty()) return CommsBoxState.AiRecap(r)
    if (latest != null) return CommsBoxState.RawLatest(latest, disclosedFallback = flagOn)
    return CommsBoxState.Empty
}
