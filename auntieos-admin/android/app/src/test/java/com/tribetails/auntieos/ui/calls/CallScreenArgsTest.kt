package com.tribetails.auntieos.ui.calls

import com.tribetails.auntieos.fcm.AuntieFirebaseMessagingService
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The lock-screen call screen used to render inside a WebView pointed at
 *
 *   https://tribetailsattendant-8587.twil.io/screen-ui?callSid=$callSid&from=$from&transcript=$transcript
 *
 * with all three values interpolated raw. A transcript is free-form speech run
 * through transcription, so "Rufus & Daisy" ended the query string early and
 * "appointment #4" dropped everything after the hash: the operator saw a truncated
 * reason for the call, or a blank one, and decided whether to answer on it.
 *
 * The screen is native now, so there is no URL to corrupt. These cases pin the
 * replacement read: the extras come from [AuntieFirebaseMessagingService]'s own
 * constants, and the transcript arrives exactly as it was sent.
 */
class CallScreenArgsTest {

    private fun argsFrom(extras: Map<String, String?>) =
        CallScreenArgs.fromExtras { key -> extras[key] }

    @Test
    fun `it reads the extras the push notification actually sets`() {
        val args = argsFrom(
            mapOf(
                AuntieFirebaseMessagingService.EXTRA_CALL_SID to "CA123",
                AuntieFirebaseMessagingService.EXTRA_CALLER_NUMBER to "+15125550100",
                AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT to "Boarding for two dogs",
            )
        )

        assertEquals("CA123", args.callSid)
        assertEquals("+15125550100", args.callerNumber)
        assertEquals("Boarding for two dogs", args.transcript)
    }

    @Test
    fun `a transcript with an ampersand survives intact`() {
        val spoken = "Rufus & Daisy need boarding Friday & Saturday"

        val args = argsFrom(mapOf(AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT to spoken))

        assertEquals(spoken, args.transcript)
    }

    @Test
    fun `a transcript with a hash survives intact`() {
        val spoken = "Following up on invoice #4402, unit #3"

        val args = argsFrom(mapOf(AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT to spoken))

        assertEquals(spoken, args.transcript)
    }

    @Test
    fun `every character a caller can say survives, including the ones a query string eats`() {
        val spoken = "Rufus & Daisy, appt #12, 50% off? yes/no; \"call back\" at 5+ pm"

        val args = argsFrom(
            mapOf(
                AuntieFirebaseMessagingService.EXTRA_CALL_SID to "CA&123#456",
                AuntieFirebaseMessagingService.EXTRA_CALLER_NUMBER to "+1 512 555 0100",
                AuntieFirebaseMessagingService.EXTRA_TRANSCRIPT to spoken,
            )
        )

        assertEquals("CA&123#456", args.callSid)
        assertEquals("+1 512 555 0100", args.callerNumber)
        assertEquals(spoken, args.transcript)
        // Nothing may be percent-encoded, escaped or clipped on the way in.
        assertEquals(spoken.length, args.transcript.length)
    }

    @Test
    fun `missing extras read as empty rather than crashing the screen`() {
        val args = argsFrom(emptyMap())

        assertEquals("", args.callSid)
        assertEquals("", args.callerNumber)
        assertEquals("", args.transcript)
    }
}
