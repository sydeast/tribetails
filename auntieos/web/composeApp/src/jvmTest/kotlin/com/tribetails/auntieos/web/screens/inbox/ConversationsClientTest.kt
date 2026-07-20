package com.tribetails.auntieos.web.screens.inbox

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Stage 2 step 7 integration: FirestoreClient conversation methods route through
 * platformInvokeCallable, answered on jvm (= desktop) by JvmFirestoreFixtures.
 */
class ConversationsClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.callableResponses = emptyMap() }

    @Test
    fun listConversationsHappyPath() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listConversations" to """{"ok":true,"conversations":[{"kinfolkId":"k1","kinfolkName":"Jane","lastMessagePreview":"hi","lastMessageAtMs":5,"lastSenderRole":"kinfolk","unreadForAdmin":true,"messageCount":2}]}""",
        )
        val r = FirestoreClient().listConversations()
        assertTrue(r is WriteResult.Ok)
        assertEquals("Jane", (r as WriteResult.Ok).value.single().kinfolkName)
    }

    @Test
    fun getThreadHappyPath() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "getConversationThread" to """{"ok":true,"kinfolkId":"k1","messages":[{"id":"m1","senderRole":"kinfolk","senderUid":"u1","body":"hi","createdAtMs":1}]}""",
        )
        val r = FirestoreClient().getConversationThread("k1")
        assertTrue(r is WriteResult.Ok)
        assertEquals("hi", (r as WriteResult.Ok).value.single().body)
    }

    @Test
    fun replyReturnsMessageId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("replyToConversation" to """{"ok":true,"kinfolkId":"k1","messageId":"m9"}""")
        val r = FirestoreClient().replyToConversation("k1", "Thanks")
        assertTrue(r is WriteResult.Ok)
        assertEquals("m9", (r as WriteResult.Ok).value)
    }

    @Test
    fun markReadOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("markConversationRead" to """{"ok":true,"kinfolkId":"k1"}""")
        val r = FirestoreClient().markConversationRead("k1")
        assertTrue(r is WriteResult.Ok)
    }

    @Test
    fun listMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("listConversations" to "not-json{")
        val r = FirestoreClient().listConversations()
        assertTrue(r is WriteResult.Err)
    }
}
