package com.tribetails.auntieos.domain

/**
 * Communicate "Recent" engagement (android). Mirror of web RecentSends.kt. Decodes
 * the listRecentSends callable payload (the Firebase SDK returns a nested Map/List)
 * into typed sends + counters that the SendGrid/Twilio webhooks bump. Pure (Map in,
 * model out) so it is unit-tested without Firebase. Kept in lockstep with web by
 * RecentSendsTest on each platform.
 */

data class SendCounts(
    val delivered: Int = 0,
    val opened: Int = 0,
    val clicked: Int = 0,
    val bounced: Int = 0,
    val failed: Int = 0,
)

data class RecentSend(
    val id: String,
    val channel: String,
    val recipientRedacted: String,
    val subject: String?,
    val sentAtMs: Long,
    val counts: SendCounts,
    val lastEvent: String?,
    /** #1610: `external` | `broadcast` | `reply`; blank from a server older than the field. */
    val kind: String = "",
    /** Broadcast only: households targeted. */
    val recipientCount: Int = 0,
    /** Broadcast only: the channels it went out on. */
    val channels: List<String> = emptyList(),
    /** Reply only: the start of what Auntie wrote. */
    val preview: String? = null,
)

private fun anyToInt(v: Any?): Int = when (v) {
    is Number -> v.toInt()
    is String -> v.toIntOrNull() ?: 0
    else -> 0
}

private fun anyToLong(v: Any?): Long = when (v) {
    is Number -> v.toLong()
    is String -> v.toLongOrNull() ?: 0L
    else -> 0L
}

private fun anyToStr(v: Any?): String = v as? String ?: ""

/** Decode the listRecentSends callable result `{ sends: [...] }` (Firebase Map shape). */
fun decodeRecentSends(raw: Map<String, Any?>?): List<RecentSend> {
    val sends = raw?.get("sends") as? List<*> ?: return emptyList()
    return sends.mapNotNull { el ->
        val o = el as? Map<*, *> ?: return@mapNotNull null
        val c = o["counts"] as? Map<*, *>
        RecentSend(
            id = anyToStr(o["id"]),
            channel = anyToStr(o["channel"]),
            recipientRedacted = anyToStr(o["recipientRedacted"]),
            subject = (o["subject"] as? String)?.ifBlank { null },
            sentAtMs = anyToLong(o["sentAtMs"]),
            counts = SendCounts(
                delivered = anyToInt(c?.get("delivered")),
                opened = anyToInt(c?.get("opened")),
                clicked = anyToInt(c?.get("clicked")),
                bounced = anyToInt(c?.get("bounced")),
                failed = anyToInt(c?.get("failed")),
            ),
            lastEvent = (o["lastEvent"] as? String)?.ifBlank { null },
            kind = anyToStr(o["kind"]),
            recipientCount = anyToInt(o["recipientCount"]),
            channels = (o["channels"] as? List<*>)?.filterIsInstance<String>().orEmpty(),
            preview = (o["preview"] as? String)?.ifBlank { null },
        )
    }
}

/** Honest one-line engagement summary; click is email-only; never fabricates rates. */
fun engagementSummary(channel: String, counts: SendCounts): String {
    // #1610: a broadcast reports reach on its own screen and a reply has no
    // provider events, so neither waits on delivery counts here.
    if (channel.equals("broadcast", ignoreCase = true) || channel.equals("message", ignoreCase = true)) return "Sent"
    val parts = buildList {
        if (counts.delivered > 0) add("${counts.delivered} delivered")
        if (counts.opened > 0) add("${counts.opened} opened")
        if (channel.equals("email", ignoreCase = true) && counts.clicked > 0) add("${counts.clicked} clicked")
        if (counts.bounced > 0) add("${counts.bounced} bounced")
        if (counts.failed > 0) add("${counts.failed} failed")
    }
    return if (parts.isEmpty()) "Sent · awaiting delivery events" else parts.joinToString(" · ")
}

fun channelLabel(channel: String): String = when (channel.lowercase()) {
    "email" -> "Email"
    "sms" -> "Text"
    "push" -> "Push"
    "inapp" -> "In-app"
    "broadcast" -> "Broadcast"
    "message" -> "Inbox reply"
    else -> channel.ifBlank { "Send" }
}

/** "12 kinfolk · Email, Text" for a broadcast row (#1610). Pure. */
fun broadcastSummaryLine(send: RecentSend): String {
    val via = send.channels.joinToString(", ") { channelLabel(it) }
    return if (via.isBlank()) "${send.recipientCount} kinfolk" else "${send.recipientCount} kinfolk · $via"
}
