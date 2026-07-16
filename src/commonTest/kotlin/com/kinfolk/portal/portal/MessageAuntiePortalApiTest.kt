package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Message Auntie (16.4) - PortalApi callable wiring tests. */
class MessageAuntiePortalApiTest {

    @Test
    fun sendKinfolkMessage_sendsBody_andReturnsMessageId() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("sendKinfolkMessage", buildJsonObject {
            put("ok", true); put("kinfolkId", "kf1"); put("messageId", "m_42")
        })
        val api = PortalApi(fake)
        val id = api.sendKinfolkMessage(body = "Hi auntie", kinfolkId = "kf1")
        assertEquals("m_42", id)
        assertEquals("sendKinfolkMessage", fake.calls[0].first)
        // payload carried the body + kinfolkId
        val payload = fake.calls[0].second!!
        assertEquals("Hi auntie", (payload["body"]!!).toString().trim('"'))
        assertEquals("kf1", (payload["kinfolkId"]!!).toString().trim('"'))
    }

    @Test
    fun sendKinfolkMessage_omitsKinfolkId_whenNull() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("sendKinfolkMessage", buildJsonObject { put("messageId", "m1") })
        val api = PortalApi(fake)
        api.sendKinfolkMessage(body = "hello")
        val payload = fake.calls[0].second!!
        assertTrue(!payload.containsKey("kinfolkId"))
    }

    @Test
    fun sendKinfolkMessage_throws_whenMessageIdMissing() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("sendKinfolkMessage", buildJsonObject { put("ok", true) })
        val api = PortalApi(fake)
        assertFailsWith<IllegalStateException> { api.sendKinfolkMessage(body = "x", kinfolkId = "kf1") }
    }

    @Test
    fun getMyConversation_decodesMessages_chronologicallyAsServerSends() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("ok", true)
            put("kinfolkId", "kf1")
            put("messages", buildJsonArray {
                add(buildJsonObject {
                    put("id", "m1"); put("senderRole", "kinfolk"); put("senderUid", "u1"); put("body", "first"); put("createdAtMs", 100L)
                })
                add(buildJsonObject {
                    put("id", "m2"); put("senderRole", "auntie"); put("senderUid", "admin"); put("body", "reply"); put("createdAtMs", 200L)
                })
            })
        })
        val api = PortalApi(fake)
        val res = api.getMyConversation("kf1")
        assertEquals("kf1", res.kinfolkId)
        assertEquals(2, res.messages.size)
        assertEquals("first", res.messages[0].body)
        assertEquals(SenderRole.Kinfolk, res.messages[0].senderRole)
        assertEquals(SenderRole.Auntie, res.messages[1].senderRole)
        assertEquals(200L, res.messages[1].createdAtMs)
    }

    @Test
    fun getMyConversation_emptyMessages_isFine() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject { put("kinfolkId", "kf1") })
        val api = PortalApi(fake)
        val res = api.getMyConversation("kf1")
        assertEquals(0, res.messages.size)
    }

    @Test
    fun getMyConversation_throws_whenKinfolkIdMissing() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject { put("messages", buildJsonArray {}) })
        val api = PortalApi(fake)
        assertFailsWith<IllegalStateException> { api.getMyConversation("kf1") }
    }

    @Test
    fun getMyConversation_decodesDeliveredAtAndReadAt() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("ok", true)
            put("kinfolkId", "kf1")
            put("messages", buildJsonArray {
                add(buildJsonObject {
                    put("id", "m1"); put("senderRole", "auntie"); put("senderUid", "admin"); put("body", "seen this?")
                    put("createdAtMs", 100L); put("deliveredAt", 100L); put("readAt", 150L)
                })
                add(buildJsonObject {
                    put("id", "m2"); put("senderRole", "auntie"); put("senderUid", "admin"); put("body", "not yet read")
                    put("createdAtMs", 200L); put("deliveredAt", 200L)
                    // readAt omitted entirely — must decode to null, not throw.
                })
            })
        })
        val api = PortalApi(fake)
        val res = api.getMyConversation("kf1")
        assertEquals(100L, res.messages[0].deliveredAt)
        assertEquals(150L, res.messages[0].readAt)
        assertEquals(200L, res.messages[1].deliveredAt)
        assertEquals(null, res.messages[1].readAt)
    }

    @Test
    fun markThreadRead_returnsMarkedCount() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("markThreadRead", buildJsonObject {
            put("ok", true); put("kinfolkId", "kf1"); put("markedCount", 3)
        })
        val api = PortalApi(fake)
        val count = api.markThreadRead(kinfolkId = "kf1")
        assertEquals(3, count)
        assertEquals("markThreadRead", fake.calls[0].first)
    }

    @Test
    fun markThreadRead_defaultsToZero_whenMarkedCountMissing() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("markThreadRead", buildJsonObject { put("ok", true); put("kinfolkId", "kf1") })
        val api = PortalApi(fake)
        assertEquals(0, api.markThreadRead(kinfolkId = "kf1"))
    }

    // -- AI message assist (O-8): generate callable wiring --

    @Test
    fun generateAssist_polish_sendsExactPayload_andReturnsText() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("generate", buildJsonObject {
            put("ok", true); put("mode", "polish")
            put("html", "<p>Hello there!</p>"); put("text", "Hello there!")
        })
        val api = PortalApi(fake)
        val text = api.generateAssist("polish", body = "hi", kinfolkId = "f1")
        assertEquals("Hello there!", text)
        assertEquals("generate", fake.calls[0].first)
        val payload = fake.calls[0].second!!
        assertEquals(3, payload.size)
        assertEquals("f1", (payload["kinfolkId"]!!).toString().trim('"'))
        assertEquals("polish", (payload["mode"]!!).toString().trim('"'))
        assertEquals("hi", (payload["body"]!!).toString().trim('"'))
    }

    @Test
    fun generateAssist_suggestReply_omitsBodyAndKinfolkId_whenNull() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("generate", buildJsonObject {
            put("ok", true); put("mode", "suggest_reply")
            put("html", "<p>Sure!</p>"); put("text", "Sure!")
        })
        val api = PortalApi(fake)
        val text = api.generateAssist("suggest_reply")
        assertEquals("Sure!", text)
        val payload = fake.calls[0].second!!
        assertEquals("suggest_reply", (payload["mode"]!!).toString().trim('"'))
        assertTrue(!payload.containsKey("body"))
        assertTrue(!payload.containsKey("kinfolkId"))
    }

    @Test
    fun generateAssist_throws_whenTextMissing() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("generate", buildJsonObject { put("ok", true); put("mode", "polish") })
        val api = PortalApi(fake)
        assertFailsWith<IllegalStateException> { api.generateAssist("polish", body = "hi") }
    }

    @Test
    fun isSendableMessage_validation() {
        assertTrue(com.kinfolk.portal.screens.messages.isSendableMessage("hi"))
        assertTrue(!com.kinfolk.portal.screens.messages.isSendableMessage("   "))
        assertTrue(!com.kinfolk.portal.screens.messages.isSendableMessage("x".repeat(5001)))
    }
}
