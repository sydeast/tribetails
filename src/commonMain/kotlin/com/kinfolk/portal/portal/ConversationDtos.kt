package com.kinfolk.portal.portal

/**
 * Message Auntie (16.4) - client model for the two-way kinfolk<->auntie thread.
 *
 * Mirrors the backend wire shape (functions/src/lib/conversations.ts ThreadMessage):
 * one conversation per household (conversations/{kinfolkId}) with a flat,
 * chronological (oldest-first) message list. The kinfolk portal only ever sees
 * its OWN thread (the callables resolve + scope by kinfolkId server-side).
 */

/** Who sent a message. Wire value: "kinfolk" | "auntie". */
enum class SenderRole { Kinfolk, Auntie }

/** A single message in the conversation. */
data class ConversationMessage(
    val id: String,
    val senderRole: SenderRole,
    val senderUid: String,
    val body: String,
    /** Epoch millis the message was created; null if the server omitted it. */
    val createdAtMs: Long?,
    /**
     * Epoch millis the message reached Firestore — always set (a direct write
     * is delivered synchronously with creation; there's no separate transport
     * hop the way email/SMS has). Null only for pre-O-20-slice-5 messages
     * written before this field existed.
     */
    val deliveredAt: Long?,
    /** Epoch millis the OTHER side read this message; null until they do. */
    val readAt: Long?,
)

/** Result of getMyConversation: the resolved household id + its messages. */
data class MyConversationResult(
    val kinfolkId: String,
    val messages: List<ConversationMessage>,
)
