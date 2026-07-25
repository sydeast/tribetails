package com.tribetails.auntieos.ui.communicate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The opt-out sentence, and what is deliberately NOT translated.
 *
 * Before this, Communicate mapped nothing: a suppressed recipient printed the
 * raw token `recipient_opted_out` at the operator, while Broadcast beside it
 * had `broadcastErrorText` doing exactly this job for its own two sentinels.
 * The web twin is `src/lib/externalSend.ts`.
 */
class ExternalSendCopyTest {

    @Test
    fun `recognises the bare sentinel`() {
        assertTrue(isOptedOutError("recipient_opted_out"))
    }

    @Test
    fun `recognises the sentinel inside the code prefix the SDK wraps it in`() {
        assertTrue(isOptedOutError("FAILED_PRECONDITION: recipient_opted_out"))
    }

    @Test
    fun `recognises the sentinel case-insensitively`() {
        assertTrue(isOptedOutError("Recipient_Opted_Out"))
    }

    @Test
    fun `does not fire on an unrelated failure that merely mentions unsubscribing`() {
        assertFalse(isOptedOutError("twilio 21610: unsubscribed recipient"))
    }

    @Test
    fun `replaces the sentinel with copy saying what happened and what to do`() {
        assertEquals(
            "This recipient has opted out. Nothing was sent. Remove their suppression before sending again.",
            externalSendErrorText("FAILED_PRECONDITION: recipient_opted_out"),
        )
    }

    @Test
    fun `passes a provider failure through verbatim, so it is never hidden`() {
        assertEquals(
            "smtp2go rejected the sender domain",
            externalSendErrorText("smtp2go rejected the sender domain"),
        )
    }

    @Test
    fun `falls back to a named message rather than an empty banner`() {
        assertEquals("The send failed.", externalSendErrorText("   "))
    }

    @Test
    fun `falls back to a named message on a null cause message`() {
        assertEquals("The send failed.", externalSendErrorText(null))
    }
}
