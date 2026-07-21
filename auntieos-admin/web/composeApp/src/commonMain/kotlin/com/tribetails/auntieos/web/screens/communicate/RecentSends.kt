package com.tribetails.auntieos.web.screens.communicate

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * Communicate "Recent" engagement: decode + summary helpers for the listRecentSends
 * callable (MyTribe functions/src/admin/listRecentSends.ts). Per-send counters are
 * bumped by the SendGrid / Twilio engagement webhooks. Pure so it is unit-tested in
 * commonTest; the composable + FirestoreClient consume these.
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

private val recentSendsJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Pure decode of the listRecentSends body `{ sends: [...] }`. Throws on malformed JSON. */
fun decodeRecentSends(dataJson: String): List<RecentSend> {
    val root = recentSendsJson.parseToJsonElement(dataJson).jsonObject
    val arr = root["sends"]?.jsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        val c = o["counts"]?.jsonObject
        RecentSend(
            id = o["id"]?.jsonPrimitive?.contentOrNull ?: "",
            channel = o["channel"]?.jsonPrimitive?.contentOrNull ?: "",
            recipientRedacted = o["recipientRedacted"]?.jsonPrimitive?.contentOrNull ?: "",
            subject = o["subject"]?.jsonPrimitive?.contentOrNull,
            sentAtMs = o["sentAtMs"]?.jsonPrimitive?.longOrNull ?: 0L,
            counts = SendCounts(
                delivered = c?.get("delivered")?.jsonPrimitive?.intOrNull ?: 0,
                opened = c?.get("opened")?.jsonPrimitive?.intOrNull ?: 0,
                clicked = c?.get("clicked")?.jsonPrimitive?.intOrNull ?: 0,
                bounced = c?.get("bounced")?.jsonPrimitive?.intOrNull ?: 0,
                failed = c?.get("failed")?.jsonPrimitive?.intOrNull ?: 0,
            ),
            lastEvent = o["lastEvent"]?.jsonPrimitive?.contentOrNull,
        )
    }
}

/**
 * Honest one-line engagement summary: shows only what the providers actually
 * reported (click is email-only). Never fabricates rates we have not measured.
 */
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

/** Display label for a channel wire value. */
fun channelLabel(channel: String): String = when (channel.lowercase()) {
    "email" -> "Email"
    "sms" -> "Text"
    else -> channel.ifBlank { "Send" }
}
