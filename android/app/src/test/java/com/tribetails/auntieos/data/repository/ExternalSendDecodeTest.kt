package com.tribetails.auntieos.data.repository

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Stage 2 step 5: pure decoders for the Communicate external-send callable payloads
 * (sendExternalMessage, suppressExternalRecipient). These are the decode contracts the
 * AuntieRepository callable methods delegate to, kept pure so they are exhaustively
 * testable without Firebase static init.
 */
class ExternalSendDecodeTest {

    // ── sendExternalMessage ──────────────────────────────────────────────────────

    @Test fun `send decode reads channel provider id and redacted recipient`() {
        val raw = mapOf(
            "ok" to true,
            "channel" to "email",
            "providerMessageId" to "msg-123",
            "recipientRedacted" to "j***@example.com",
        )
        val r = decodeExternalSendResult(raw, "sms")
        assertEquals("email", r.channel)
        assertEquals("msg-123", r.providerMessageId)
        assertEquals("j***@example.com", r.recipientRedacted)
    }

    @Test fun `send decode falls back to requested channel and empties when missing`() {
        val r = decodeExternalSendResult(mapOf("ok" to true), "sms")
        assertEquals("sms", r.channel)
        assertEquals("", r.providerMessageId)
        assertEquals("", r.recipientRedacted)
    }

    @Test fun `send decode tolerates null payload`() {
        val r = decodeExternalSendResult(null, "email")
        assertEquals("email", r.channel)
        assertEquals("", r.providerMessageId)
        assertEquals("", r.recipientRedacted)
    }

    @Test fun `send decode falls back when server channel is blank`() {
        val r = decodeExternalSendResult(mapOf("channel" to ""), "sms")
        assertEquals("sms", r.channel)
    }

    // ── suppressExternalRecipient ────────────────────────────────────────────────

    @Test fun `suppress decode reads channel and redacted recipient`() {
        val r = decodeExternalSuppressResult(
            mapOf("ok" to true, "channel" to "sms", "recipientRedacted" to "+1******7890"),
            "email",
        )
        assertEquals("sms", r.channel)
        assertEquals("+1******7890", r.recipientRedacted)
    }

    @Test fun `suppress decode falls back to requested channel and empty redacted`() {
        val r = decodeExternalSuppressResult(mapOf("ok" to true), "email")
        assertEquals("email", r.channel)
        assertEquals("", r.recipientRedacted)
    }

    @Test fun `suppress decode tolerates null payload`() {
        val r = decodeExternalSuppressResult(null, "sms")
        assertEquals("sms", r.channel)
        assertEquals("", r.recipientRedacted)
    }
}
