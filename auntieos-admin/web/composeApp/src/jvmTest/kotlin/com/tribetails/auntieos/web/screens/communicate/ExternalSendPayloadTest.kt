package com.tribetails.auntieos.web.screens.communicate

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.Json

class ExternalSendPayloadTest {
    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    @Test fun sms_reply_is_transactional_and_omits_subject() {
        val o = obj(externalSendPayloadJson("sms", "+14155552671", subject = null, body = "hi", transactional = true))
        assertEquals("sms", o["channel"]!!.jsonPrimitive.content)
        assertEquals("+14155552671", o["to"]!!.jsonPrimitive.content)
        assertEquals("hi", o["body"]!!.jsonPrimitive.content)
        assertEquals(true, o["transactional"]!!.jsonPrimitive.content.toBoolean())
        assertFalse(o.containsKey("subject"))
    }

    @Test fun oneoff_email_keeps_subject_and_defaults_non_transactional() {
        val o = obj(externalSendPayloadJson("email", "a@b.com", subject = "Hi", body = "x", transactional = false))
        assertEquals("Hi", o["subject"]!!.jsonPrimitive.content)
        assertEquals(false, o["transactional"]!!.jsonPrimitive.content.toBoolean())
    }
}
