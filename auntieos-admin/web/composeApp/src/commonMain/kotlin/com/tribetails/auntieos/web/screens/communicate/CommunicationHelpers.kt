package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.CallLog
import com.tribetails.auntieos.web.data.EmailMessage
import com.tribetails.auntieos.web.data.SmsMessage
import com.tribetails.auntieos.web.data.VoicemailLog

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
    return r.take(max).trimEnd() + "…"
}

data class LatestComm(
    val channel: String,   // "sms" | "email" | "call" | "voicemail"
    val timestamp: String, // ISO-8601 UTC string
    val snippet: String,
)

private fun commSnippet(text: String, max: Int = 140): String {
    val t = text.trim()
    return if (t.length <= max) t else t.take(max).trimEnd() + "…"
}

/**
 * The single most recent record across the four comms lists, by ISO timestamp
 * (lexicographic compare — same UTC format sorts correctly). Entries with a
 * blank timestamp are ignored. null if nothing qualifies.
 */
fun latestCommunication(
    sms: List<SmsMessage>,
    emails: List<EmailMessage>,
    calls: List<CallLog>,
    voicemails: List<VoicemailLog>,
): LatestComm? {
    val candidates = buildList {
        sms.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("sms", it.timestamp, commSnippet(it.body))) }
        emails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("email", it.timestamp, commSnippet(it.subject.ifBlank { it.body }))) }
        calls.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("call", it.timestamp, commSnippet(it.transcript.ifBlank { it.status }))) }
        voicemails.forEach { if (it.timestamp.isNotBlank()) add(LatestComm("voicemail", it.timestamp, commSnippet(it.transcript))) }
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
