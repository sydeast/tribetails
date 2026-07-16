package com.tribetails.auntieos.web.screens.inbox

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Stage 2 step 7: pure conversation decode + validation helpers. */
class ConversationsTest {

    @Test fun decodeConversationsSortableFields() {
        val json = """{"ok":true,"conversations":[
            {"kinfolkId":"a","kinfolkName":"A","lastMessagePreview":"hi","lastMessageAtMs":20,"lastSenderRole":"kinfolk","unreadForAdmin":true,"messageCount":3},
            {"kinfolkId":"b","kinfolkName":"B","lastMessagePreview":"yo","lastMessageAtMs":10,"lastSenderRole":"auntie","unreadForAdmin":false,"messageCount":1}
        ]}"""
        val list = decodeConversations(json)
        assertEquals(2, list.size)
        assertEquals("A", list[0].kinfolkName)
        assertTrue(list[0].unreadForAdmin)
        assertEquals(20L, list[0].lastMessageAtMs)
        assertEquals(3, list[0].messageCount)
    }

    @Test fun decodeConversationsEmptyWhenAbsent() =
        assertEquals(0, decodeConversations("""{"ok":true}""").size)

    @Test fun decodeThreadParsesMessagesAndRole() {
        val json = """{"ok":true,"kinfolkId":"a","messages":[
            {"id":"m1","senderRole":"kinfolk","senderUid":"u1","body":"first","createdAtMs":100},
            {"id":"m2","senderRole":"auntie","senderUid":"admin","body":"reply","createdAtMs":200}
        ]}"""
        val msgs = decodeThread(json)
        assertEquals(2, msgs.size)
        assertEquals("first", msgs[0].body)
        assertTrue(msgs[1].isFromAuntie)
        assertEquals(200L, msgs[1].createdAtMs)
    }

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
}
