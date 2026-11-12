package com.tribetails.auntieos.web.screens.admin

import com.tribetails.auntieos.web.data.PushWording
import com.tribetails.auntieos.web.data.WORDING_FIELD_PUSH_BODY
import com.tribetails.auntieos.web.data.WORDING_FIELD_PUSH_TITLE
import com.tribetails.auntieos.web.data.WORDING_FIELD_TEXT
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.decodeTemplateChannels
import com.tribetails.auntieos.web.data.saveTemplateChannelsPayload
import com.tribetails.auntieos.web.data.wordingFieldErrors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1935: the pure half of the text message and push notification editor: what
 * the server's answer decodes to, what a save sends, which field a refusal
 * belongs to, and the words for each "not set" state.
 */
class TemplateChannelWordingTest {

    // ── decode ───────────────────────────────────────────────────────────────

    @Test fun decodesAFullResponse() {
        val c = decodeTemplateChannels(
            """
            {"templateId":"kincare.booking.confirm","notificationLabel":"KinCare booking confirmed",
             "fields":["kinName","serviceType"],
             "sms":{"supported":true,"set":true,"text":"Booked for {{kinName}}.","maxLength":1600},
             "push":{"supported":true,"set":true,"title":"Booked","body":"Tap for {{kinName}}.",
                     "titleMaxLength":100,"bodyMaxLength":500}}
            """.trimIndent(),
        )
        assertEquals("KinCare booking confirmed", c.notificationLabel)
        assertEquals(listOf("kinName", "serviceType"), c.fields)
        assertTrue(c.sms.supported && c.sms.set)
        assertEquals("Booked for {{kinName}}.", c.sms.text)
        assertEquals(1600, c.sms.maxLength)
        assertTrue(c.push.supported && c.push.set)
        assertEquals("Booked", c.push.title)
        assertEquals("Tap for {{kinName}}.", c.push.body)
        assertEquals(100, c.push.titleMaxLength)
        assertEquals(500, c.push.bodyMaxLength)
    }

    @Test fun aTemplateNoNotificationSendsDecodesAsUnsupported() {
        val c = decodeTemplateChannels(
            """
            {"templateId":"my.own","notificationLabel":null,"fields":[],
             "sms":{"supported":false,"set":false,"text":"","maxLength":1600},
             "push":{"supported":false,"set":false,"title":"","body":"","titleMaxLength":100,"bodyMaxLength":500}}
            """.trimIndent(),
        )
        assertNull(c.notificationLabel)
        assertFalse(c.sms.supported)
        assertFalse(c.push.supported)
        assertTrue(c.fields.isEmpty())
    }

    @Test fun missingFieldsReadAsNotSupportedWithNoKnownLimit() {
        val c = decodeTemplateChannels("""{"templateId":"x"}""")
        assertNull(c.notificationLabel)
        assertTrue(c.fields.isEmpty())
        assertFalse(c.sms.supported)
        assertFalse(c.sms.set)
        assertEquals("", c.sms.text)
        assertEquals(0, c.sms.maxLength)
        assertFalse(c.push.supported)
        assertEquals(0, c.push.titleMaxLength)
    }

    @Test fun malformedJsonThrowsRatherThanInventingWording() {
        assertFailsWith<Exception> { decodeTemplateChannels("not json") }
    }

    // ── what a save sends ────────────────────────────────────────────────────

    @Test fun savingTheTextMessageSendsNoPush() {
        val o = Json.parseToJsonElement(saveTemplateChannelsPayload("k", "Hello", null)).jsonObject
        assertEquals(setOf("templateId", "sms"), o.keys)
        assertEquals("Hello", o["sms"]!!.jsonObject["text"]!!.jsonPrimitive.content)
    }

    @Test fun savingThePushNotificationSendsNoTextMessage() {
        val o = Json.parseToJsonElement(saveTemplateChannelsPayload("k", null, PushWording("T", "B"))).jsonObject
        assertEquals(setOf("templateId", "push"), o.keys)
        assertEquals("T", o["push"]!!.jsonObject["title"]!!.jsonPrimitive.content)
        assertEquals("B", o["push"]!!.jsonObject["body"]!!.jsonPrimitive.content)
    }

    // ── which field a refusal belongs to ─────────────────────────────────────

    @Test fun aRefusalNamesEachFieldItRefused() {
        val err = WriteResult.Err(
            message = "Title cannot be empty. Message is 501 characters. The limit is 500.",
            details = """{"reason":"template-wording-refused","fieldErrors":{
                "pushTitle":"Title cannot be empty.","pushBody":"Message is 501 characters. The limit is 500."}}""",
        )
        val byField = wordingFieldErrors(err)
        assertEquals("Title cannot be empty.", byField[WORDING_FIELD_PUSH_TITLE])
        assertEquals("Message is 501 characters. The limit is 500.", byField[WORDING_FIELD_PUSH_BODY])
        assertNull(byField[WORDING_FIELD_TEXT])
    }

    @Test fun anyOtherFailureHasNoFieldErrors() {
        assertTrue(wordingFieldErrors(WriteResult.Err("The server could not be reached.")).isEmpty())
        assertTrue(wordingFieldErrors(WriteResult.Err("x", details = """{"reason":"something-else","fieldErrors":{"smsText":"y"}}""")).isEmpty())
        assertTrue(wordingFieldErrors(WriteResult.Err("x", details = "not json")).isEmpty())
        assertTrue(wordingFieldErrors(WriteResult.Err("x", details = """{"reason":"template-wording-refused"}""")).isEmpty())
    }

    // ── the pre-check, in the server's words ─────────────────────────────────

    @Test fun emptyAndBlankAreRefusedByName() {
        assertEquals("Text message cannot be empty.", wordingPrecheck("Text message", "", 1600))
        assertEquals("Title cannot be empty.", wordingPrecheck("Title", "   ", 100))
    }

    @Test fun overTheLimitGivesBothNumbers() {
        assertEquals("Message is 501 characters. The limit is 500.", wordingPrecheck("Message", "x".repeat(501), 500))
    }

    @Test fun lengthIsCountedTrimmedLikeTheServer() {
        assertNull(wordingPrecheck("Title", "  " + "x".repeat(100) + "  ", 100))
    }

    @Test fun anUnknownLimitIsLeftToTheServer() {
        assertNull(wordingPrecheck("Text message", "x".repeat(5000), 0))
        assertEquals("5000 characters", wordingCounter("x".repeat(5000), 0))
    }

    @Test fun theCounterReadsCountOfLimit() {
        assertEquals("5 of 1600 characters", wordingCounter(" Hello ", 1600))
    }

    // ── "Not set", and why ───────────────────────────────────────────────────

    @Test fun aTemplateNotSavedYetAsksForThatFirst() {
        for (channel in WordingChannel.entries) {
            assertEquals("Save this template first.", channelNotSetReason(channel, templateSaved = false, supported = true, notificationLabel = "X"))
        }
    }

    @Test fun aTemplateNoNotificationSendsSaysSo() {
        assertEquals(
            "No notification sends this template, so it has no text message.",
            channelNotSetReason(WordingChannel.TEXT, templateSaved = true, supported = false, notificationLabel = null),
        )
        assertEquals(
            "No notification sends this template, so it has no push notification.",
            channelNotSetReason(WordingChannel.PUSH, templateSaved = true, supported = false, notificationLabel = null),
        )
    }

    @Test fun aNotificationThatDoesNotSendTheChannelSaysSo() {
        assertEquals(
            "This notification is not sent by text message.",
            channelNotSetReason(WordingChannel.TEXT, templateSaved = true, supported = false, notificationLabel = "Password reset"),
        )
        assertEquals(
            "This notification is not sent as a push notification.",
            channelNotSetReason(WordingChannel.PUSH, templateSaved = true, supported = false, notificationLabel = "Password reset"),
        )
    }

    @Test fun aSupportedChannelHasNoReasonSoItCanBeAdded() {
        for (channel in WordingChannel.entries) {
            assertNull(channelNotSetReason(channel, templateSaved = true, supported = true, notificationLabel = "X"))
        }
    }

    @Test fun theOperatorNeverReadsAStoredNameOrADeveloperWord() {
        val words = WordingChannel.entries.flatMap {
            listOf(it.title, it.noun, it.notSent, it.addLabel, it.saveLabel, it.savedNotice)
        } + listOf(CHANNEL_EMAIL, CHANNEL_NOT_SET, SAVE_TEMPLATE_FIRST)
        for (w in words) {
            assertFalse(Regex("sms|Templates|Handlebars|—", RegexOption.IGNORE_CASE).containsMatchIn(w), w)
        }
        assertEquals(listOf("Text message", "Push notification"), WordingChannel.entries.map { it.title })
    }
}
