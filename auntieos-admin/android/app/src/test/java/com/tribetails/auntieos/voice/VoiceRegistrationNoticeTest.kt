package com.tribetails.auntieos.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the operator is told, pinned here rather than only in a composable.
 *
 * Until #433, `VoiceTokenState` had no production consumer at all. Every failure
 * the manager carefully classified (a Twilio secret nobody had set, an account
 * without the claim, no network) reached the operator as exactly nothing, while
 * the consequence was inbound business calls that never arrived. So "there is a
 * banner" is a behaviour worth a test, and so is "there is NOT one" for the
 * states where a banner would be noise.
 */
class VoiceRegistrationNoticeTest {

    @Test
    fun `a registered device says nothing`() {
        assertNull(voiceRegistrationNotice(VoiceTokenState.Registered("auntie", 3_600_000L)))
    }

    @Test
    fun `an attempt in flight says nothing, so no banner flashes on every launch`() {
        assertNull(voiceRegistrationNotice(VoiceTokenState.Working))
    }

    @Test
    fun `an unattempted registration says nothing, because nothing has gone wrong yet`() {
        assertNull(voiceRegistrationNotice(VoiceTokenState.Idle))
    }

    @Test
    fun `a missing Twilio secret names the secret, which is the whole point of the banner`() {
        val notice = voiceRegistrationNotice(
            VoiceTokenState.Misconfigured(
                secret = "TWIML_APP_SID",
                detailCode = "missing_secret",
                message = "Voice calling is not configured yet: the TWIML_APP_SID secret is not set.",
            )
        )

        assertNotNull(notice)
        // The name turns "calling is broken" into one thing to go and set. A
        // banner without it sends the operator looking.
        assertTrue(notice!!.detail.contains("TWIML_APP_SID"))
        assertTrue(notice.title.contains("Incoming calls"))
    }

    @Test
    fun `an account without permission gets a different sentence, because it has a different fix`() {
        val notice = voiceRegistrationNotice(
            VoiceTokenState.NotAuthorized("This account is not allowed to answer the business line.")
        )

        assertNotNull(notice)
        assertEquals("This account cannot answer the business line", notice!!.title)
        assertTrue(notice.detail.contains("not allowed to answer"))
        // And emphatically not the "go set a secret" copy: sending someone at the
        // wrong fix is barely better than telling them nothing.
        assertTrue(!notice.detail.contains("secret"))
    }

    @Test
    fun `a generic failure carries the reason through rather than flattening it`() {
        val notice = voiceRegistrationNotice(
            VoiceTokenState.Failed("Twilio refused this device's registration: AccessTokenInvalid")
        )

        assertNotNull(notice)
        assertTrue(notice!!.detail.contains("AccessTokenInvalid"))
    }

    @Test
    fun `the no-push-token failure reaches the operator too`() {
        // This one is actionable by the operator alone: allow notifications.
        val notice = voiceRegistrationNotice(
            VoiceTokenState.Failed(
                "This device has no push token yet, so it cannot be registered to receive calls. " +
                    "Reopen the app once notifications are allowed."
            )
        )

        assertNotNull(notice)
        assertTrue(notice!!.detail.contains("notifications are allowed"))
    }
}
