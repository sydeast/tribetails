package com.tribetails.auntieos.web.screens.communicate

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #1610 on the desktop console. The rules mirror the server and the React admin. */
class BroadcastMergeTest {
    @Test fun `merge fields a broadcast fills pass, anything else is named`() {
        assertEquals(emptyList<String>(), unsupportedMergeFields("Hi {{firstName}} {{ lastName }} {{kinfolkName}} {{business}}"))
        assertEquals(
            listOf("firstname", "kinName", "{{#if paid}}", "{{/if}}"),
            unsupportedMergeFields("Hi {{firstname}}", "{{kinName}} {{#if paid}}x{{/if}}"),
        )
        assertEquals(listOf("}}"), unsupportedMergeFields("oops }} here"))
        assertNull(mergeFieldBlocker("Hi", "Hi {{firstName}},"))
        assertTrue(mergeFieldBlocker("", "Hi {{name}}")!!.endsWith("Remove or fix: name."))
        assertEquals("Kinfolk", KINFOLK_NAME_STAND_IN)
    }

    @Test fun `By status toggles in the Directory's order`() {
        assertEquals(listOf("active", "prospect", "inactive"), BROADCAST_STATUS_OPTIONS)
        val t = toggleBroadcastStatus(toggleBroadcastStatus("", "inactive", true), "active", true)
        assertEquals("active, inactive", t)
        assertEquals("inactive", toggleBroadcastStatus(t, "active", false))
    }

    @Test fun `the reach reply decodes into the confirm's line`() {
        val p = decodeBroadcastAudiencePreview(
            """{"ok":true,"targeted":12,"withEmail":10,"withPhone":11,"withApp":4,"withoutFirstName":1}""",
        )
        assertEquals(BroadcastAudiencePreview(12, 10, 11, 4, 1), p)
        assertEquals(
            "12 kinfolk match this audience (10 with an email address, 11 with a phone number, 4 with the app). " +
                "1 has no first name on file and will read \"Kinfolk\" where you wrote {{firstName}}.",
            reachLine(p),
        )
        assertFailsWith<IllegalArgumentException> { decodeBroadcastAudiencePreview("""{"ok":true}""") }
    }

    @Test fun `a generated Subject line leaves the body`() {
        assertEquals(SubjectSplit("Big day", "Hi Dana"), splitSubjectLine("Subject: Big day\n\nHi Dana"))
        assertEquals(SubjectSplit("Big day", "Hi"), splitSubjectLine("**Subject:** Big day\nHi"))
        assertEquals(SubjectSplit("", "Hi, the subject: today"), splitSubjectLine("Hi, the subject: today"))
    }

    @Test fun `Recent decodes broadcasts and Inbox replies`() {
        val sends = decodeRecentSends(
            """{"sends":[
              {"id":"broadcast_b1","kind":"broadcast","channel":"broadcast","recipientRedacted":"All active kinfolk","subject":"Holiday hours","sentAtMs":300,"recipientCount":12,"channels":["email","sms"],"counts":{}},
              {"id":"reply_kf1","kind":"reply","channel":"message","recipientRedacted":"Dre East","subject":null,"sentAtMs":200,"preview":"See you Tuesday","counts":{}}
            ]}""",
        )
        assertEquals("12 kinfolk · Email, Text", broadcastSummaryLine(sends[0]))
        assertEquals("Broadcast", channelLabel(sends[0].channel))
        assertEquals("Inbox reply", channelLabel(sends[1].channel))
        assertEquals("See you Tuesday", sends[1].preview)
        assertEquals("Sent", engagementSummary("message", SendCounts()))
    }

    @Test fun `the server's merge-field refusal reads as a sentence`() {
        assertEquals(
            "The message has merge fields a broadcast cannot fill (firstname). Nothing was sent.",
            broadcastErrorText("unsupported_merge_fields: firstname"),
        )
    }
}
