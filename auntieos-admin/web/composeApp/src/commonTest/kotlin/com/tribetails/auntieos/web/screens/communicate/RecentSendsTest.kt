package com.tribetails.auntieos.web.screens.communicate

import kotlin.test.Test
import kotlin.test.assertEquals

class RecentSendsTest {

    @Test
    fun decode_parsesSendsWithCounts() {
        val json = """
            {"sends":[
              {"id":"s1","channel":"email","recipientRedacted":"j***@x.com","subject":"Hi","sentAtMs":1717800000000,
               "counts":{"delivered":2,"opened":1,"clicked":0,"bounced":0,"failed":0},"lastEvent":"opened"},
              {"id":"s2","channel":"sms","recipientRedacted":"+1****7890","subject":null,"sentAtMs":1717700000000,
               "counts":{"delivered":1,"opened":0,"clicked":0,"bounced":0,"failed":0},"lastEvent":"delivered"}
            ]}
        """.trimIndent()
        val out = decodeRecentSends(json)
        assertEquals(2, out.size)
        assertEquals("s1", out[0].id)
        assertEquals(1, out[0].counts.opened)
        assertEquals(null, out[1].subject)
        assertEquals("Text", channelLabel(out[1].channel))
    }

    @Test
    fun decode_emptyAndMissingSends() {
        assertEquals(emptyList(), decodeRecentSends("""{}"""))
        assertEquals(emptyList(), decodeRecentSends("""{"sends":[]}"""))
    }

    @Test
    fun summary_isHonest_neverFabricates() {
        assertEquals("Sent · awaiting delivery events", engagementSummary("email", SendCounts()))
        assertEquals("2 delivered · 1 opened", engagementSummary("email", SendCounts(delivered = 2, opened = 1)))
        // click is email-only: an SMS click count (shouldn't happen) is not shown
        assertEquals("1 delivered", engagementSummary("sms", SendCounts(delivered = 1, clicked = 5)))
        assertEquals("1 failed", engagementSummary("sms", SendCounts(failed = 1)))
    }
}
