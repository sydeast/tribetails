package com.tribetails.auntieos.ui.admin

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.repository.PushWording
import com.tribetails.auntieos.data.repository.decodeTemplateChannels
import com.tribetails.auntieos.data.repository.saveTemplateChannelsPayload
import com.tribetails.auntieos.data.repository.wordingFieldErrorsFromDetails
import com.tribetails.auntieos.data.repository.wordingFieldErrorsOf
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1935: the pure half of the text-message and push wording editor. */
class TemplateChannelWordingTest {

    private val full: Map<String, Any?> = mapOf(
        "templateId" to "kincare.booking.confirm",
        "notificationLabel" to "KinCare booking confirmed",
        "fields" to listOf("kinName", "serviceType"),
        "sms" to mapOf("supported" to true, "set" to true, "text" to "Booked for {{kinName}}.", "maxLength" to 1600),
        "push" to mapOf(
            "supported" to true, "set" to false, "title" to "", "body" to "",
            "titleMaxLength" to 100L, "bodyMaxLength" to 500.0,
        ),
    )

    @Test
    fun `decodes the whole answer, limits included`() {
        val c = decodeTemplateChannels(full)
        assertEquals("KinCare booking confirmed", c.notificationLabel)
        assertEquals(listOf("kinName", "serviceType"), c.fields)
        assertTrue(c.sms.supported)
        assertTrue(c.sms.set)
        assertEquals("Booked for {{kinName}}.", c.sms.text)
        assertEquals(1600, c.sms.maxLength)
        assertTrue(c.push.supported)
        assertFalse(c.push.set)
        // The callable hands numbers back as Int, Long or Double depending on size.
        assertEquals(100, c.push.titleMaxLength)
        assertEquals(500, c.push.bodyMaxLength)
    }

    @Test
    fun `an answer with pieces missing reads as not sent, never as editable`() {
        val c = decodeTemplateChannels(mapOf("templateId" to "x"))
        assertNull(c.notificationLabel)
        assertEquals(emptyList<String>(), c.fields)
        assertFalse(c.sms.supported)
        assertFalse(c.sms.set)
        assertEquals("", c.sms.text)
        assertFalse(c.push.supported)
        assertEquals("", c.push.title)
        assertEquals("", c.push.body)
    }

    @Test
    fun `a template no notification sends decodes as unsupported on both`() {
        val c = decodeTemplateChannels(
            mapOf(
                "notificationLabel" to null,
                "fields" to emptyList<String>(),
                "sms" to mapOf("supported" to false, "set" to false, "text" to "", "maxLength" to 1600),
                "push" to mapOf("supported" to false, "set" to false, "title" to "", "body" to ""),
            ),
        )
        assertNull(c.notificationLabel)
        assertFalse(c.sms.supported)
        assertFalse(c.push.supported)
    }

    @Test
    fun `a save carries only the channel being saved`() {
        assertEquals(
            mapOf("templateId" to "a.b", "sms" to mapOf("text" to "Hi")),
            saveTemplateChannelsPayload("a.b", smsText = "Hi", push = null),
        )
        assertEquals(
            mapOf("templateId" to "a.b", "push" to mapOf("title" to "T", "body" to "B")),
            saveTemplateChannelsPayload("a.b", smsText = null, push = PushWording("T", "B")),
        )
    }

    private fun refusal(details: Any?): FirebaseFunctionsException {
        val e = mockk<FirebaseFunctionsException>()
        every { e.details } returns details
        every { e.message } returns "Title cannot be empty. Message cannot be empty."
        return e
    }

    @Test
    fun `a refused save hands back one sentence per field`() {
        val e = refusal(
            mapOf(
                "reason" to "template-wording-refused",
                "fieldErrors" to mapOf("pushTitle" to "Title cannot be empty.", "pushBody" to "Message cannot be empty."),
            ),
        )
        assertEquals(
            mapOf("pushTitle" to "Title cannot be empty.", "pushBody" to "Message cannot be empty."),
            wordingFieldErrorsOf(e),
        )
    }

    @Test
    fun `any other failure carries no field sentences`() {
        assertEquals(emptyMap<String, String>(), wordingFieldErrorsOf(refusal(null)))
        assertEquals(emptyMap<String, String>(), wordingFieldErrorsOf(refusal(mapOf("reason" to "something-else"))))
        assertEquals(emptyMap<String, String>(), wordingFieldErrorsOf(IllegalStateException("offline")))
        assertEquals(emptyMap<String, String>(), wordingFieldErrorsOf(null))
        assertEquals(
            emptyMap<String, String>(),
            wordingFieldErrorsFromDetails(mapOf("reason" to "template-wording-refused", "fieldErrors" to "nope")),
        )
        // A blank or non-text sentence is dropped rather than shown as an empty red line.
        assertEquals(
            mapOf("smsText" to "Text message cannot be empty."),
            wordingFieldErrorsFromDetails(
                mapOf(
                    "reason" to "template-wording-refused",
                    "fieldErrors" to mapOf("smsText" to "Text message cannot be empty.", "pushTitle" to " ", "pushBody" to 4),
                ),
            ),
        )
    }

    @Test
    fun `the pre-check uses the server's sentences and counts trimmed`() {
        assertEquals("Text message cannot be empty.", wordingPrecheck("Text message", "   ", 1600))
        assertEquals("Title cannot be empty.", wordingPrecheck("Title", "", 100))
        assertEquals("Message is 501 characters. The limit is 500.", wordingPrecheck("Message", "x".repeat(501), 500))
        assertNull(wordingPrecheck("Message", "  " + "x".repeat(500) + "  ", 500))
        assertNull(wordingPrecheck("Text message", "Hi {{kinName}}", 1600))
        // No limit in the answer: the server still decides, this screen does not guess one.
        assertNull(wordingPrecheck("Title", "x".repeat(5000), 0))
    }

    @Test
    fun `the counter counts what the server will count`() {
        assertEquals("2 of 1600 characters", wordingCounter(" Hi ", 1600))
    }

    @Test
    fun `not set says why, and stays quiet when the channel can be added`() {
        for (channel in WordingChannel.entries) {
            assertEquals(
                "Save this template first.",
                channelNotSetMessage(channel, saved = false, supported = false, notificationLabel = null),
            )
            assertNull(channelNotSetMessage(channel, saved = true, supported = true, notificationLabel = "Booked"))
        }
        assertEquals(
            "No notification sends this template, so it has no text message.",
            channelNotSetMessage(WordingChannel.TEXT, saved = true, supported = false, notificationLabel = null),
        )
        assertEquals(
            "This notification is not sent by text message.",
            channelNotSetMessage(WordingChannel.TEXT, saved = true, supported = false, notificationLabel = "Password reset"),
        )
        assertEquals(
            "No notification sends this template, so it has no push notification.",
            channelNotSetMessage(WordingChannel.PUSH, saved = true, supported = false, notificationLabel = null),
        )
        assertEquals(
            "This notification is not sent as a push notification.",
            channelNotSetMessage(WordingChannel.PUSH, saved = true, supported = false, notificationLabel = "Password reset"),
        )
    }

    @Test
    fun `the words on screen are the operator's, not the stored names`() {
        val words = WordingChannel.entries.flatMap { listOf(it.title, it.add, it.save, it.saved) } +
            listOf(CHANNEL_EMAIL, CHANNEL_NOT_SET, CHANNEL_SAVE_FIRST, CHANNEL_LOAD_FAILED, CHANNEL_SAVE_FAILED)
        assertEquals(listOf("Text message", "Push notification"), WordingChannel.entries.map { it.title })
        for (w in words) {
            assertFalse(w, Regex("(?i)\\bsms\\b|handlebars|smsTemplates|pushTemplates|—").containsMatchIn(w))
        }
    }

    @Test
    fun `texts split at 160 then 153, the same count the web editor makes`() {
        assertEquals(SmsSegments(0, false), smsSegments("   "))
        assertEquals(SmsSegments(1, false), smsSegments("a".repeat(160)))
        assertEquals(SmsSegments(2, false), smsSegments("a".repeat(161)))
        assertEquals(SmsSegments(2, false), smsSegments("a".repeat(306)))
        assertEquals(SmsSegments(3, false), smsSegments("a".repeat(307)))
        assertEquals(1, smsSegments("  ${"a".repeat(160)}  ").segments)
        // A bracket takes two places, a euro sign too.
        assertEquals(2, smsSegments("${"a".repeat(159)}{").segments)
        assertEquals(1, smsSegments("${"a".repeat(158)}€").segments)
    }

    @Test
    fun `an emoji or curly quote drops each text to 70 then 67`() {
        assertEquals(SmsSegments(1, true), smsSegments("${"a".repeat(69)}’"))
        assertEquals(SmsSegments(2, true), smsSegments("${"a".repeat(70)}’"))
        assertEquals(3, smsSegments("${"a".repeat(133)}🐾").segments)
    }

    @Test
    fun `the texts line is plain words`() {
        assertNull(smsSegmentHint(""))
        assertEquals("Sends as 1 text.", smsSegmentHint("Hi {{kinName}}"))
        assertEquals("Sends as 2 texts.", smsSegmentHint("a".repeat(200)))
        assertEquals(
            "Sends as 1 text. An emoji or special character makes each text shorter.",
            smsSegmentHint("Hi 🐾"),
        )
    }

    @Test
    fun `half-written push wording counts as wording to finish`() {
        val blank = com.tribetails.auntieos.data.repository.PushChannel(true, false, "", "", 100, 500)
        assertFalse(pushHasWording(blank))
        assertTrue(pushHasWording(blank.copy(title = "Booked")))
        assertTrue(pushHasWording(blank.copy(body = "Tap")))
        assertTrue(pushHasWording(blank.copy(set = true)))
    }

    @Test
    fun `a field chip lands on the end with a space before it`() {
        assertEquals("{{kinName}}", appendField("", "kinName"))
        assertEquals("Hi {{kinName}}", appendField("Hi", "kinName"))
        assertEquals("Hi {{kinName}}", appendField("Hi ", "kinName"))
    }
}
