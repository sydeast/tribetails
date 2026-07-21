package com.tribetails.auntieos.web.screens.inbox

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// ─────────────────────────────────────────────────────────────────────────────
// Inbox conversations (Stage 2 step 7 / Message Auntie 16.4): pure models +
// decode + validation for the two-way kinfolk<->auntie threads. All decision
// logic lives here so it is unit-tested on pure JVM (commonTest). The callables
// (listConversations / getConversationThread / replyToConversation /
// markConversationRead) are the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

/** A conversation thread summary (one per kinfolk household). */
data class ConversationSummary(
    val kinfolkId: String,
    val kinfolkName: String,
    val lastMessagePreview: String,
    val lastMessageAtMs: Long,
    val lastSenderRole: String,
    val unreadForAdmin: Boolean,
    val messageCount: Int,
)

/** A single message in a thread. */
data class ThreadMessage(
    val id: String,
    val senderRole: String, // "kinfolk" | "auntie"
    val senderUid: String,
    val body: String,
    val createdAtMs: Long,
) {
    val isFromAuntie: Boolean get() = senderRole == "auntie"
}

private val conversationsJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Pure decode of listConversations `{ok, conversations:[...]}`. Throws on malformed JSON. */
fun decodeConversations(dataJson: String): List<ConversationSummary> {
    val o = conversationsJson.parseToJsonElement(dataJson).jsonObject
    val arr = o["conversations"] as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val c = el.jsonObject
        val id = c["kinfolkId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        ConversationSummary(
            kinfolkId = id,
            kinfolkName = c["kinfolkName"]?.jsonPrimitive?.contentOrNull ?: id,
            lastMessagePreview = c["lastMessagePreview"]?.jsonPrimitive?.contentOrNull ?: "",
            lastMessageAtMs = c["lastMessageAtMs"]?.jsonPrimitive?.doubleOrNull?.toLong() ?: 0L,
            lastSenderRole = c["lastSenderRole"]?.jsonPrimitive?.contentOrNull ?: "",
            unreadForAdmin = c["unreadForAdmin"]?.jsonPrimitive?.booleanOrNull ?: false,
            messageCount = c["messageCount"]?.jsonPrimitive?.intOrNull ?: 0,
        )
    }
}

/** Pure decode of a thread `{ok, kinfolkId, messages:[...]}`. Throws on malformed JSON. */
fun decodeThread(dataJson: String): List<ThreadMessage> {
    val o = conversationsJson.parseToJsonElement(dataJson).jsonObject
    val arr = o["messages"] as? JsonArray ?: return emptyList()
    return arr.mapNotNull { el ->
        val m = el.jsonObject
        val id = m["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        ThreadMessage(
            id = id,
            senderRole = m["senderRole"]?.jsonPrimitive?.contentOrNull ?: "kinfolk",
            senderUid = m["senderUid"]?.jsonPrimitive?.contentOrNull ?: "",
            body = m["body"]?.jsonPrimitive?.contentOrNull ?: "",
            createdAtMs = m["createdAtMs"]?.jsonPrimitive?.doubleOrNull?.toLong() ?: 0L,
        )
    }
}

/** Reply readiness: a non-blank body within the server max. Returns reason or null. */
fun replyBlocker(body: String): String? {
    if (body.trim().isEmpty()) return "Write a reply first."
    if (body.length > 5000) return "Message is too long (5000 character max)."
    return null
}

/** Count of threads with an unread kinfolk message, for the Inbox badge. Pure. */
fun unreadConversationCount(list: List<ConversationSummary>): Int = list.count { it.unreadForAdmin }
