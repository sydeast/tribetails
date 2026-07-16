package com.kinfolk.portal.screens.messages

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Message Auntie (16.4) - controller send/reload + fail-loud logic. */
class MessageAuntieControllerTest {

    private fun emptyThread(fake: FakeFunctionsClient) {
        fake.stub("getMyConversation", buildJsonObject { put("kinfolkId", "3"); put("messages", buildJsonArray {}) })
    }

    @Test
    fun reload_loadsMessages() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3")
            put("messages", buildJsonArray {
                add(buildJsonObject { put("id", "m1"); put("senderRole", "kinfolk"); put("body", "hi"); put("createdAtMs", 1L) })
            })
        })
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload()
        assertEquals(1, c.messages?.size)
        assertNull(c.loadError)
        assertNull(c.sendError)
    }

    @Test
    fun reload_failureSetsLoadErrorOnly() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyConversation", IllegalStateException("boom"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload()
        assertEquals("boom", c.loadError)
        assertNull(c.sendError)
        assertNull(c.messages)
    }

    @Test
    fun reload_successAfterFailureClearsLoadError() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyConversation", IllegalStateException("boom"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload()
        assertEquals("boom", c.loadError)
        // Retry path: the server recovers and reload() clears the load error.
        emptyThread(fake)
        c.reload()
        assertNull(c.loadError)
        assertEquals(0, c.messages?.size)
    }

    @Test
    fun send_callsSendThenRefetches() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stub("sendKinfolkMessage", buildJsonObject { put("messageId", "m_new") })
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload() // 1st getMyConversation
        var cleared = false
        c.send("Hello auntie") { cleared = true }
        advanceUntilIdle()
        assertTrue(fake.calls.any { it.first == "sendKinfolkMessage" })
        // initial reload + post-send reload = 2 getMyConversation calls
        assertEquals(2, fake.calls.count { it.first == "getMyConversation" })
        assertTrue(cleared, "onSent should fire to clear the input")
        assertTrue(!c.sending)
    }

    @Test
    fun send_blankIsNoOp() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.send("   ") { }
        advanceUntilIdle()
        assertTrue(fake.calls.none { it.first == "sendKinfolkMessage" })
    }

    @Test
    fun send_overCapIsNoOp() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.send("x".repeat(MAX_MESSAGE_BODY + 1)) { }
        advanceUntilIdle()
        assertTrue(fake.calls.none { it.first == "sendKinfolkMessage" })
    }

    @Test
    fun send_concurrentSecondCallIsDropped() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stub("sendKinfolkMessage", buildJsonObject { put("messageId", "m1") })
        val c = MessageAuntieController("3", PortalApi(fake), this)
        // Two back-to-back sends before the dispatcher runs the first: the second
        // hits the `|| sending` re-entrancy guard and is dropped (no double-send).
        c.send("first") { }
        c.send("second") { }
        advanceUntilIdle()
        assertEquals(1, fake.calls.count { it.first == "sendKinfolkMessage" })
    }

    @Test
    fun send_surfacesErrorFailLoud() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stubError("sendKinfolkMessage", IllegalStateException("nope"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload()
        c.send("hi") { }
        advanceUntilIdle()
        assertTrue(c.sendError != null)
        assertTrue(!c.sending)
    }

    @Test
    fun send_failureNeverTouchesLoadErrorOrThread() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyConversation", buildJsonObject {
            put("kinfolkId", "3")
            put("messages", buildJsonArray {
                add(buildJsonObject { put("id", "m1"); put("senderRole", "auntie"); put("body", "hello"); put("createdAtMs", 1L) })
            })
        })
        fake.stubError("sendKinfolkMessage", IllegalStateException("nope"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload()
        var cleared = false
        c.send("hi") { cleared = true }
        advanceUntilIdle()
        // The failed send sets sendError only; the loaded thread stays intact
        // (so the screen never swaps it for the load empty-state) and onSent
        // never fires (the draft is preserved for "Try again").
        assertEquals("nope", c.sendError)
        assertNull(c.loadError)
        assertEquals(1, c.messages?.size)
        assertTrue(!cleared, "onSent must not fire on failure so the draft survives")
    }

    @Test
    fun send_failureThenRetrySucceedsAndClearsSendError() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stubError("sendKinfolkMessage", IllegalStateException("nope"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload()
        c.send("hi") { }
        advanceUntilIdle()
        assertEquals("nope", c.sendError)
        // "Try again": the server recovers and the same draft resends clean.
        fake.stub("sendKinfolkMessage", buildJsonObject { put("messageId", "m_retry") })
        var cleared = false
        c.send("hi") { cleared = true }
        advanceUntilIdle()
        assertNull(c.sendError)
        assertTrue(cleared, "onSent fires on the successful retry")
        assertEquals(2, fake.calls.count { it.first == "sendKinfolkMessage" })
    }

    // -- AI message assist (O-8) --

    @Test
    fun polish_happyPath_deliversTextAndClearsAssisting() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stub("generate", buildJsonObject {
            put("ok", true); put("mode", "polish"); put("html", "<p>Polished!</p>"); put("text", "Polished!")
        })
        val c = MessageAuntieController("3", PortalApi(fake), this)
        var result: String? = null
        c.polish("rough draft") { result = it }
        assertTrue(c.assisting, "assisting flips on synchronously (re-entrancy guard)")
        advanceUntilIdle()
        assertEquals("Polished!", result)
        assertTrue(!c.assisting)
        assertNull(c.assistError)
    }

    @Test
    fun polish_failureSetsAssistError_andNeverFiresOnResult() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stubError("generate", IllegalStateException("rate_limited"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        var fired = false
        c.polish("rough draft") { fired = true }
        advanceUntilIdle()
        assertTrue(c.assistError != null)
        assertTrue(!fired, "onResult must not fire on failure so the draft survives")
        assertTrue(!c.assisting)
        // Assist failures never touch the send/load surfaces.
        assertNull(c.sendError)
        assertNull(c.loadError)
    }

    @Test
    fun polish_unsendableDraftIsNoOp() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.polish("   ") { }
        c.polish("x".repeat(MAX_MESSAGE_BODY + 1)) { }
        advanceUntilIdle()
        assertTrue(fake.calls.none { it.first == "generate" })
    }

    @Test
    fun suggestReply_happyPath_deliversText() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stub("generate", buildJsonObject {
            put("ok", true); put("mode", "suggest_reply"); put("html", "<p>A reply</p>"); put("text", "A reply")
        })
        val c = MessageAuntieController("3", PortalApi(fake), this)
        var result: String? = null
        c.suggestReply { result = it }
        advanceUntilIdle()
        assertEquals("A reply", result)
        assertTrue(!c.assisting)
        assertNull(c.assistError)
    }

    @Test
    fun assist_concurrentSecondCallIsDropped() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stub("generate", buildJsonObject {
            put("ok", true); put("mode", "polish"); put("html", "<p>x</p>"); put("text", "x")
        })
        val c = MessageAuntieController("3", PortalApi(fake), this)
        // Two back-to-back assists before the dispatcher runs the first: the
        // second hits the `assisting` re-entrancy guard and is dropped.
        c.polish("first") { }
        c.suggestReply { }
        advanceUntilIdle()
        assertEquals(1, fake.calls.count { it.first == "generate" })
    }

    @Test
    fun dismissAssistError_clearsBannerState() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stubError("generate", IllegalStateException("ai_unavailable"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.polish("hi") { }
        advanceUntilIdle()
        assertTrue(c.assistError != null)
        c.dismissAssistError()
        assertNull(c.assistError)
    }

    @Test
    fun dismissSendError_clearsBannerState() = runTest {
        val fake = FakeFunctionsClient()
        emptyThread(fake)
        fake.stubError("sendKinfolkMessage", IllegalStateException("nope"))
        val c = MessageAuntieController("3", PortalApi(fake), this)
        c.reload()
        c.send("hi") { }
        advanceUntilIdle()
        assertTrue(c.sendError != null)
        c.dismissSendError()
        assertNull(c.sendError)
    }
}
