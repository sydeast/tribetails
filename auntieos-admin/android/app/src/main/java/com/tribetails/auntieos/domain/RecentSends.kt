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
        )
    }
}

/** Honest one-line engagement summary; click is email-only; never fabricates rates. */
fun engagementSummary(channel: String, counts: SendCounts): String {
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
    else -> channel.ifBlank { "Send" }
}
