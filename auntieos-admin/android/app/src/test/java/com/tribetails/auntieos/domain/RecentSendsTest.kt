package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Test

/** Android Communicate engagement decode (mirror of web RecentSendsTest). */
class RecentSendsTest {

    @Test
    fun decode_parsesFirebaseMapShape_coercingNumbers() {
        val raw = mapOf<String, Any?>(
            "sends" to listOf(
                mapOf(
                    "id" to "s1", "channel" to "email", "recipientRedacted" to "j***@x.com",
                    "subject" to "Hi", "sentAtMs" to 1717800000000L,
                    // Firebase numbers arrive as Double/Long/Int interchangeably
                    "counts" to mapOf("delivered" to 2.0, "opened" to 1L, "clicked" to 0, "bounced" to 0, "failed" to 0),
                    "lastEvent" to "opened",
                ),
                mapOf(
                    "id" to "s2", "channel" to "sms", "recipientRedacted" to "+1****7890",
                    "subject" to null, "sentAtMs" to 1717700000000L,
                    "counts" to mapOf("delivered" to 1, "opened" to 0, "clicked" to 0, "bounced" to 0, "failed" to 0),
                    "lastEvent" to "delivered",
                ),
            ),
        )
        val out = decodeRecentSends(raw)
        assertEquals(2, out.size)
        assertEquals(2, out[0].counts.delivered)
        assertEquals(1, out[0].counts.opened)
        assertEquals(null, out[1].subject)
        assertEquals("Text", channelLabel(out[1].channel))
    }

    @Test
    fun decode_emptyAndMissing() {
        assertEquals(emptyList<RecentSend>(), decodeRecentSends(null))
        assertEquals(emptyList<RecentSend>(), decodeRecentSends(mapOf("sends" to emptyList<Any?>())))
    }

    @Test
    fun summary_isHonest() {
        assertEquals("Sent · awaiting delivery events", engagementSummary("email", SendCounts()))
        assertEquals("2 delivered · 1 opened", engagementSummary("email", SendCounts(delivered = 2, opened = 1)))
        assertEquals("1 delivered", engagementSummary("sms", SendCounts(delivered = 1, clicked = 5)))
    }
}
