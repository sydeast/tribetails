package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * #1610 for the desktop console: broadcast merge fields, the By status picker,
 * the pre-send count, and one subject on a generated email. Mirrors the React
 * admin (src/lib/broadcastMerge.ts, src/api/communicateGenerate.ts) and the
 * server (mytribe/functions/src/lib/broadcastMerge.ts), which fills the fields
 * per household on every channel. Pure, so commonTest covers it.
 */

/** The fields a broadcast fills per household. */
val BROADCAST_MERGE_FIELDS: List<String> = listOf("firstName", "lastName", "kinfolkName", "business", "Business")

/** Operator ruling, 2026-11-05: a blank first name reads "Kinfolk". */
const val KINFOLK_NAME_STAND_IN = "Kinfolk"

/** The Directory's kinfolk statuses, in its order. Archived is never matched by a broadcast. */
val BROADCAST_STATUS_OPTIONS: List<String> = listOf("active", "prospect", "inactive")

private val SIMPLE_TOKEN = Regex("""\{\{\s*([A-Za-z_]\w*)\s*\}\}""")
private val STRAY_BRACES = Regex("""\{\{[^}]*\}*\}?|\}\}""")

/** Every field (or stray brace run) a broadcast cannot fill, first-seen order, no repeats. */
fun unsupportedMergeFields(vararg texts: String?): List<String> {
    val out = LinkedHashSet<String>()
    for (text in texts) {
        if (text.isNullOrEmpty()) continue
        SIMPLE_TOKEN.findAll(text).forEach { m ->
            val name = m.groupValues[1]
            if (name !in BROADCAST_MERGE_FIELDS) out += name
        }
        STRAY_BRACES.findAll(text.replace(SIMPLE_TOKEN, "")).forEach { out += it.value.trim() }
    }
    return out.toList()
}

/** The composer's refusal for unfillable fields, or null. */
fun mergeFieldBlocker(subject: String, body: String): String? {
    val bad = unsupportedMergeFields(subject, body)
    if (bad.isEmpty()) return null
    return "A broadcast can fill {{firstName}}, {{lastName}}, {{kinfolkName}} and {{business}} only. Remove or fix: ${bad.joinToString(", ")}."
}

/** Toggles one status in or out of the comma-joined list, kept in picker order. */
fun toggleBroadcastStatus(statusesText: String, status: String, on: Boolean): String {
    val list = statusesText.split(',').map { it.trim() }.filter { it.isNotEmpty() && it != status }.toMutableList()
    if (on) list += status
    return BROADCAST_STATUS_OPTIONS.filter { it in list }.joinToString(", ")
}

/** What `previewBroadcastAudience` answers. */
data class BroadcastAudiencePreview(
    val targeted: Int,
    val withEmail: Int,
    val withPhone: Int,
    val withApp: Int,
    val withoutFirstName: Int,
)

private val previewJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Decodes the callable body. Throws when it carries no count, so the caller reports why. */
fun decodeBroadcastAudiencePreview(dataJson: String): BroadcastAudiencePreview {
    val o = previewJson.parseToJsonElement(dataJson).jsonObject
    fun n(k: String): Int = o[k]?.jsonPrimitive?.intOrNull ?: 0
    requireNotNull(o["targeted"]?.jsonPrimitive?.intOrNull) { "previewBroadcastAudience returned no count" }
    return BroadcastAudiencePreview(n("targeted"), n("withEmail"), n("withPhone"), n("withApp"), n("withoutFirstName"))
}

/** The confirm's reach line, word for word the React admin's. */
fun reachLine(p: BroadcastAudiencePreview): String {
    val base = "${p.targeted} kinfolk match this audience (${p.withEmail} with an email address, " +
        "${p.withPhone} with a phone number, ${p.withApp} with the app)."
    if (p.withoutFirstName == 0) return base
    val who = if (p.withoutFirstName == 1) "1 has" else "${p.withoutFirstName} have"
    return "$base $who no first name on file and will read \"$KINFOLK_NAME_STAND_IN\" where you wrote {{firstName}}."
}

/** Generated copy split into its own subject line (if any) and the body without it. */
data class SubjectSplit(val subject: String, val body: String)

private val SUBJECT_LINE = Regex("""^\s*(?:\*\*)?\s*subject\s*:\s*(.*?)\s*(?:\*\*)?\s*(?:\r?\n|$)""", RegexOption.IGNORE_CASE)

/** Cuts a leading `Subject: ...` line and the blank lines after it from generated copy. */
fun splitSubjectLine(text: String): SubjectSplit {
    val m = SUBJECT_LINE.find(text) ?: return SubjectSplit("", text)
    if (m.range.first != 0) return SubjectSplit("", text)
    val body = text.substring(m.range.last + 1).replace(Regex("""^\s*\n"""), "").trimStart()
    return SubjectSplit(m.groupValues[1].replace("**", "").trim(), body)
}

/** "12 kinfolk · Email, Text" for a broadcast row in Recent. */
fun broadcastSummaryLine(send: RecentSend): String {
    val via = send.channels.joinToString(", ") { channelLabel(it) }
    return if (via.isBlank()) "${send.recipientCount} kinfolk" else "${send.recipientCount} kinfolk · $via"
}
