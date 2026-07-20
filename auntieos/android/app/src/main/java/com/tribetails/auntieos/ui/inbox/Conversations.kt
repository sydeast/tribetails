package com.tribetails.auntieos.ui.inbox

// ─────────────────────────────────────────────────────────────────────────────
// Inbox conversations (Stage 2 step 7 / Message Auntie 16.4): pure models +
// decode (from Firebase callable Map payloads) + validation. Android parity with
// web (web/.../screens/inbox/Conversations.kt). Unit-tested at unit-test scope.
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

/** Decodes the listConversations payload. Pure; unit-tested. */
@Suppress("UNCHECKED_CAST")
internal fun decodeConversations(raw: Map<String, Any?>?): List<ConversationSummary> {
    val arr = raw?.get("conversations") as? List<*> ?: return emptyList()
    return arr.mapNotNull { el ->
        val c = el as? Map<String, Any?> ?: return@mapNotNull null
        val id = c["kinfolkId"] as? String ?: return@mapNotNull null
        ConversationSummary(
            kinfolkId = id,
            kinfolkName = (c["kinfolkName"] as? String) ?: id,
            lastMessagePreview = (c["lastMessagePreview"] as? String).orEmpty(),
            lastMessageAtMs = (c["lastMessageAtMs"] as? Number)?.toLong() ?: 0L,
            lastSenderRole = (c["lastSenderRole"] as? String).orEmpty(),
            unreadForAdmin = c["unreadForAdmin"] == true,
            messageCount = (c["messageCount"] as? Number)?.toInt() ?: 0,
        )
    }
}

/** Decodes a thread payload into messages. Pure; unit-tested. */
@Suppress("UNCHECKED_CAST")
internal fun decodeThread(raw: Map<String, Any?>?): List<ThreadMessage> {
    val arr = raw?.get("messages") as? List<*> ?: return emptyList()
    return arr.mapNotNull { el ->
        val m = el as? Map<String, Any?> ?: return@mapNotNull null
        val id = m["id"] as? String ?: return@mapNotNull null
        ThreadMessage(
            id = id,
            senderRole = (m["senderRole"] as? String) ?: "kinfolk",
            senderUid = (m["senderUid"] as? String).orEmpty(),
            body = (m["body"] as? String).orEmpty(),
            createdAtMs = (m["createdAtMs"] as? Number)?.toLong() ?: 0L,
        )
    }
}

/** Decodes a reply's messageId. Pure. */
internal fun decodeReplyMessageId(raw: Map<String, Any?>?): String = (raw?.get("messageId") as? String).orEmpty()

/** Reply readiness: a non-blank body within the server max. Returns reason or null. */
fun replyBlocker(body: String): String? {
    if (body.trim().isEmpty()) return "Write a reply first."
    if (body.length > 5000) return "Message is too long (5000 character max)."
    return null
}

/** Count of threads with an unread kinfolk message. Pure. */
fun unreadConversationCount(list: List<ConversationSummary>): Int = list.count { it.unreadForAdmin }
