package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #1609: the confirm names the person and the channel, with web's and Android's sentences. */
class InvoiceNoticePreviewTest {
    private val base = InvoiceNoticePreview(
        hasRecipient = true,
        recipientName = "Robin Wren",
        email = InvoiceNoticePreview.Channel(on = true, address = "catch@hanasamku.com"),
        householdGateLive = true,
    )

    @Test
    fun namesThePersonAndEachChannel() {
        assertEquals(
            "Goes to Robin Wren by email to catch@hanasamku.com and a phone notification, and in their notifications list.",
            noticePreviewSentence(base.copy(push = InvoiceNoticePreview.Channel(on = true))),
        )
    }

    @Test
    fun saysWhenNothingWillReachThem() {
        assertEquals(
            "Household notices are paused before launch, so Robin Wren will not hear about this yet.",
            noticePreviewSentence(base.copy(householdGateLive = false)),
        )
        assertEquals(
            "No one in this household can receive billing notices, so nobody will be told.",
            noticePreviewSentence(base.copy(hasRecipient = false)),
        )
    }

    @Test
    fun decodesTheCallableAnswer() {
        val decoded = decodeInvoiceNoticePreview(
            """{"ok":true,"key":"invoice.reminder","hasRecipient":true,"recipientName":"Robin Wren",""" +
                """"email":{"on":true,"address":"catch@hanasamku.com"},"sms":{"on":false,"address":""},""" +
                """"push":{"on":false},"disabled":null,"householdGateLive":true}""",
        )
        assertTrue(decoded.email.on)
        assertFalse(decoded.sms.on)
        assertEquals("Robin Wren", decoded.recipientName)
    }
}
