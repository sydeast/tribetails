package com.tribetails.auntieos.ui.inbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Stage 2 step 7: pure conversation decode + validation helpers (android parity). */
class ConversationsTest {

    @Test fun decodeConversationsParsesFields() {
        val raw = mapOf(
            "conversations" to listOf(
                mapOf(
                    "kinfolkId" to "a", "kinfolkName" to "A", "lastMessagePreview" to "hi",
                    "lastMessageAtMs" to 20.0, "lastSenderRole" to "kinfolk",
                    "unreadForAdmin" to true, "messageCount" to 3.0,
                ),
            ),
        )
        val list = decodeConversations(raw)
        assertEquals(1, list.size)
        assertEquals("A", list[0].kinfolkName)
        assertTrue(list[0].unreadForAdmin)
        assertEquals(20L, list[0].lastMessageAtMs)
        assertEquals(3, list[0].messageCount)
    }

    @Test fun decodeConversationsEmptyWhenAbsent() =
        assertEquals(0, decodeConversations(mapOf("ok" to true)).size)

    @Test fun decodeThreadParsesRoleAndBody() {
        val raw = mapOf(
            "messages" to listOf(
                mapOf("id" to "m1", "senderRole" to "kinfolk", "senderUid" to "u1", "body" to "first", "createdAtMs" to 100.0),
                mapOf("id" to "m2", "senderRole" to "auntie", "senderUid" to "admin", "body" to "reply", "createdAtMs" to 200.0),
            ),
        )
        val msgs = decodeThread(raw)
        assertEquals(2, msgs.size)
        assertEquals("first", msgs[0].body)
        assertTrue(msgs[1].isFromAuntie)
        assertEquals(200L, msgs[1].createdAtMs)
    }

    @Test fun decodeReplyMessageIdReadsId() =
        assertEquals("m9", decodeReplyMessageId(mapOf("ok" to true, "messageId" to "m9")))

    @Test fun replyBlockerCatchesBlankAndTooLong() {
        assertNotNull(replyBlocker("   "))
        assertNotNull(replyBlocker("x".repeat(5001)))
        assertNull(replyBlocker("hello"))
    }

    @Test fun unreadCount() {
        val list = listOf(
            ConversationSummary("a", "A", "", 1, "kinfolk", true, 1),
            ConversationSummary("b", "B", "", 1, "auntie", false, 1),
            ConversationSummary("c", "C", "", 1, "kinfolk", true, 1),
        )
        assertEquals(2, unreadConversationCount(list))
    }

    // ── waiting/answered grouping (parity with src/lib/inboxFormat.ts) ────────

    @Test fun groupThreadsByWaitingPutsWaitingFirst() {
        val sections = groupThreadsByWaiting(
            listOf(
                ConversationSummary("a", "A", "", 2, "auntie", false, 1),
                ConversationSummary("b", "B", "", 1, "kinfolk", true, 1),
            ),
        )
        assertEquals(listOf(ThreadSectionKey.WAITING, ThreadSectionKey.ANSWERED), sections.map { it.key })
        assertEquals(listOf("b"), sections[0].threads.map { it.kinfolkId })
        assertEquals(listOf("a"), sections[1].threads.map { it.kinfolkId })
    }

    @Test fun groupThreadsByWaitingKeepsBothSectionsWhenOneIsEmpty() {
        val sections = groupThreadsByWaiting(
            listOf(ConversationSummary("a", "A", "", 1, "auntie", false, 1)),
        )
        assertEquals(2, sections.size)
        assertEquals(ThreadSectionKey.WAITING, sections[0].key)
        assertEquals("Waiting on a reply", sections[0].label)
        assertTrue(sections[0].threads.isEmpty())
    }

    @Test fun groupThreadsByWaitingReturnsBothSectionsForNoThreadsAtAll() {
        val sections = groupThreadsByWaiting(emptyList())
        assertEquals(2, sections.size)
        assertTrue(sections.all { it.threads.isEmpty() })
    }

    @Test fun groupThreadsByWaitingAgreesWithTheBadgeCount() {
        val list = listOf(
            ConversationSummary("a", "A", "", 1, "kinfolk", true, 1),
            ConversationSummary("b", "B", "", 1, "auntie", false, 1),
            ConversationSummary("c", "C", "", 1, "kinfolk", true, 1),
        )
        assertEquals(unreadConversationCount(list), groupThreadsByWaiting(list)[0].threads.size)
    }

    // ── markAllThreadsRead payload decode ────────────────────────────────────

    @Test fun decodeClearedCountReadsTheServersOwnNumber() =
        assertEquals(4, decodeClearedCount(mapOf("ok" to true, "cleared" to 4.0)))

    @Test fun decodeClearedCountRefusesToGuessWhenTheFieldIsMissing() {
        // A missing count is a broken response, not "zero cleared": reporting
        // zero would tell the operator nothing happened when it may well have.
        assertNull(decodeClearedCount(mapOf("ok" to true)))
        assertNull(decodeClearedCount(null))
    }
}
