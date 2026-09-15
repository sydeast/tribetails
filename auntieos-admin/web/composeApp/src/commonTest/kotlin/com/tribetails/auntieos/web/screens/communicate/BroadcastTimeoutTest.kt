package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.AUNTIE_TIMEOUT_MESSAGE
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #867 review: a broadcast that timed out may still be sending. The operator is
 * told to resend the same draft, which lands on the same broadcast, and is warned
 * when an edit would turn the next Send into a second blast.
 */
class BroadcastTimeoutTest {

    private fun signature(body: String = "Walks are back on Monday.", channels: List<BroadcastChannel> = listOf(BroadcastChannel.Email, BroadcastChannel.Sms)) =
        broadcastSignature(
            segmentId = null,
            kind = SegmentKind.Tags,
            statusesText = "",
            tags = listOf("VIP"),
            tagMatch = TagMatch.Any,
            channels = channels,
            subject = "Walks",
            body = body,
        )

    @Test
    fun aTimeoutSaysTheSendMayStillBeRunningAndToResendUnchanged() {
        val text = broadcastErrorText(AUNTIE_TIMEOUT_MESSAGE)
        assertEquals("The send may still be running. Press Send again without changing anything to see its status.", text)
        assertFalse(text.contains("Check your connection"))
        assertTrue(isBroadcastTimeout(AUNTIE_TIMEOUT_MESSAGE))
        assertFalse(isBroadcastTimeout("FAILED_PRECONDITION: no_recipients"))
        assertEquals("raw provider boom", broadcastErrorText("raw provider boom"))
    }

    @Test
    fun theSignatureIsStableForTheSameDraftAndChangesWithAnyEdit() {
        assertEquals(signature(), signature())
        // Channel order is not an edit.
        assertEquals(signature(channels = listOf(BroadcastChannel.Sms, BroadcastChannel.Email)), signature())
        assertNotEquals(signature(body = "Walks are back on Tuesday."), signature())
        assertNotEquals(signature(channels = listOf(BroadcastChannel.Email)), signature())
    }

    @Test
    fun editingAfterATimeoutWarnsThatSendStartsANewBroadcast() {
        val timedOut = signature()
        assertNull(broadcastEditWarning(null, signature(body = "edited")), "no timeout, no warning")
        assertNull(broadcastEditWarning(timedOut, signature()), "the unchanged draft resends onto the same broadcast")
        val warning = broadcastEditWarning(timedOut, signature(body = "Walks are back on Tuesday."))
        assertTrue(warning != null && warning.contains("separate broadcast"), "$warning")
    }
}
